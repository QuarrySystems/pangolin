// pangolin.config.mjs — operator config for the offload-fanout example.
//
// Exports:
//   default / client  — wired PangolinClient (namespace 'offload-fanout')
//   orch              — OrchContext: { transport, storage, anchor, verifySignature, runService }
//
// IMPORT-SAFE: no throw at load when the Claude credential (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN) is absent.
// The live-run guard (exit 1 on missing key) lives in src/index.ts, not here.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PangolinClient, NoopCredentialProvider, StdoutResultSink } from '@quarry-systems/pangolin-client';
import { claudeAuthSecrets } from '@quarry-systems/pangolin-core';
import { LocalStorageProvider } from '@quarry-systems/pangolin-storage-local';
import { LocalDockerProvider } from '@quarry-systems/pangolin-providers-local-docker';
import { LocalSecretStore } from '@quarry-systems/pangolin-secret-store';
import {
  PangolinOrchestrator,
  SqliteRunStateStore,
  ManualTrigger,
  DispatchExecutor,
  AuditLog,
  LocalAnchor,
  createLocalSigner,
  verifyEd25519,
  MailboxSubmissionTransport,
  LocalDirMailbox,
  serve,
} from '@quarry-systems/pangolin-orchestrator';

// ---------------------------------------------------------------------------
// Path setup — use stable per-host dirs so containers can bind-mount them.
// The db path is process-unique to avoid SQLITE_BUSY on concurrent/repeat
// imports from parallel CLI invocations.
// ---------------------------------------------------------------------------
const rootDir = join(tmpdir(), 'pangolin-fanout-storage');
const secretDir = join(tmpdir(), 'pangolin-fanout-secrets');
const mailboxDir = join(tmpdir(), 'pangolin-fanout-mailbox');
const dbPath = join(tmpdir(), `pangolin-fanout-${process.pid}.db`);

const workerImage = 'ghcr.io/quarrysystems/pangolin-worker:latest';

// ---------------------------------------------------------------------------
// PangolinClient — lazy: no Docker/network until dispatch fires.
// ---------------------------------------------------------------------------
export const client = new PangolinClient({
  namespace: 'offload-fanout',
  compute: { 'local-docker': new LocalDockerProvider({ allowUnpinnedImage: true }) },
  storage: new LocalStorageProvider({ rootDir }),
  secretStores: { local: new LocalSecretStore({ dir: secretDir }) },
  credentials: { none: new NoopCredentialProvider() },
  targets: { local: { compute: 'local-docker', credentials: 'none', secretStore: 'local' } },
  resultSink: new StdoutResultSink(),
});

export default client;

// ---------------------------------------------------------------------------
// Audit + orchestrator setup (IMPORT-SAFE: constructors are lazy / in-memory).
// ---------------------------------------------------------------------------
const store = new SqliteRunStateStore(dbPath);
// Defensive: release the SQLite handle on process exit so the OS-level file lock
// is always freed even if the caller forgets to call store.close() explicitly.
process.on('exit', () => { try { store.close(); } catch {} });
const signer = createLocalSigner();
const anchor = new LocalAnchor(store);
const auditLog = new AuditLog({ store, signer, anchor });

const orchestrator = new PangolinOrchestrator({
  store,
  executors: {
    dispatch: new DispatchExecutor({
      client,
      target: 'local',
      workerImage,
      secrets: claudeAuthSecrets().secrets,
    }),
  },
  triggers: { manual: new ManualTrigger() },
  queues: { default: { concurrency: 2 } },
  auditLog,
});

/** Verify an ed25519 signature produced by our local signer. */
const verifySignature = (root, sig) => verifyEd25519(root, sig, signer.publicKey);

const transport = new MailboxSubmissionTransport(new LocalDirMailbox(mailboxDir));

/** Start the serve loop; returns a Promise that resolves when signal fires. */
const runService = (signal) => serve({ orchestrator, transport, signal });

export const orch = {
  transport,
  storage: client.storage,
  anchor,
  verifySignature,
  runService,
};
