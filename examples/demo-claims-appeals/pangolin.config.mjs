// pangolin.config.mjs — operator config for the demo-claims-appeals example.
//
// Exports:
//   default / client  — wired PangolinClient (namespace 'demo-claims-appeals')
//   orch              — OrchContext: { transport, storage, anchor, verifySignature, runService }
//
// IMPORT-SAFE: no throw at load when ANTHROPIC_API_KEY is absent.
// The live-run guard (exit 1 on missing key) lives in src/index.ts, not here.
//
// TAMPER TIER: this config uses LocalAnchor → the bundle reads `tamper-detecting`.
// For the tamper-EVIDENT (external-immutable) recording, swap LocalAnchor for
// S3ObjectLockAnchor here — that is the ONLY change needed.

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';

import { PangolinClient, NoopCredentialProvider, StdoutResultSink } from '@quarry-systems/pangolin-client';
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
  verifyEd25519,
  MailboxSubmissionTransport,
  LocalDirMailbox,
  serve,
} from '@quarry-systems/pangolin-orchestrator';

const rootDir = join(tmpdir(), 'pangolin-claims-storage');
const secretDir = join(tmpdir(), 'pangolin-claims-secrets');
const mailboxDir = join(tmpdir(), 'pangolin-claims-mailbox');
// Stable (NOT per-pid) so the multi-process CLI flow shares one store:
// `pangolin orch serve` seals the audit root via LocalAnchor → store.putAuditRoot,
// and a SEPARATE `pangolin orch audit|verify|watch` process must read it back via
// store.getAuditRoot. A ${process.pid} path would give each process its own empty
// DB → anchor.fetch misses → false "TAMPERED". (Stale dev .db files in tmpdir
// may be cleared between runs; not required for correctness.)
const dbPath = join(tmpdir(), 'pangolin-claims.db');

const workerImage = 'ghcr.io/quarrysystems/pangolin-worker:latest';

// Deterministic SEEDED signer — the established cross-process pattern (see
// examples/offload-minio/pangolin.config.mjs). `pangolin orch serve` signs the
// audit root and a SEPARATE `pangolin orch verify|audit` process verifies it; a
// random per-process keypair (createLocalSigner) would never match cross-process.
// Derive ONE ed25519 keypair from a fixed seed shared via this config (override
// with PANGOLIN_SIGNER_SEED_HEX, 64 hex chars). DEV ONLY — production obtains the
// public key out-of-band (e.g. KMS), not a shared seed. No file I/O → import-safe.
const seedHex =
  process.env.PANGOLIN_SIGNER_SEED_HEX ??
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const privKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), // PKCS8 ed25519 prefix
    Buffer.from(seedHex, 'hex'), // 32-byte seed
  ]),
  format: 'der',
  type: 'pkcs8',
});
const signer = {
  keyRef: 'demo-claims-dev',
  publicKey: createPublicKey(privKey).export({ type: 'spki', format: 'der' }),
  async sign(root) {
    return { alg: 'ed25519', bytes: new Uint8Array(edSign(null, Buffer.from(root), privKey)), keyRef: 'demo-claims-dev' };
  },
};

export const client = new PangolinClient({
  namespace: 'demo-claims-appeals',
  compute: { 'local-docker': new LocalDockerProvider({ allowUnpinnedImage: true }) },
  storage: new LocalStorageProvider({ rootDir }),
  secretStores: { local: new LocalSecretStore({ dir: secretDir }) },
  credentials: { none: new NoopCredentialProvider() },
  targets: { local: { compute: 'local-docker', credentials: 'none', secretStore: 'local' } },
  resultSink: new StdoutResultSink(),
});

export default client;

const store = new SqliteRunStateStore(dbPath);
process.on('exit', () => { try { store.close(); } catch {} });
const anchor = new LocalAnchor(store);
const auditLog = new AuditLog({ store, signer, anchor });

const orchestrator = new PangolinOrchestrator({
  store,
  executors: {
    dispatch: new DispatchExecutor({
      client,
      target: 'local',
      workerImage,
      // Standard inline pattern (matches every other example): the launcher
      // supplies ANTHROPIC_API_KEY — `start:env` via `tsx --env-file`, or the
      // operator exports it / compose sets `env_file` before `pangolin orch serve`.
      secrets: {
        ANTHROPIC_API_KEY: { inline: process.env.ANTHROPIC_API_KEY ?? '' },
      },
    }),
  },
  triggers: { manual: new ManualTrigger() },
  queues: { default: { concurrency: 2 } },
  auditLog,
});

const verifySignature = (root, sig) => verifyEd25519(root, sig, signer.publicKey);

const transport = new MailboxSubmissionTransport(new LocalDirMailbox(mailboxDir));

const runService = (signal) => serve({ orchestrator, transport, signal });

export const orch = {
  transport,
  storage: client.storage,
  anchor,
  verifySignature,
  runService,
};
