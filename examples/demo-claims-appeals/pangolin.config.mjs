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
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';

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
// DB → anchor.fetch misses → false "TAMPERED". Clear this file between runs.
const dbPath = join(tmpdir(), 'pangolin-claims.db');
const signerKeyFile = join(tmpdir(), 'pangolin-claims-signer.pem');

const workerImage = 'ghcr.io/quarrysystems/pangolin-worker:latest';

// PERSISTED signer keypair — same cross-process reason as the stable dbPath.
// `createLocalSigner()` mints a FRESH random ed25519 keypair per call, so the
// `serve` process would sign the audit root with one key and a separate
// `verify`/`audit` process would check it with a different key → "signature
// false / TAMPERED". Persist the private key so every process loads the same
// one. (Demo-only convenience; a real deployment uses a managed KMS key.)
function loadOrCreateSigner(keyRef = 'local') {
  let privateKey;
  if (existsSync(signerKeyFile)) {
    privateKey = createPrivateKey({ key: readFileSync(signerKeyFile), format: 'pem', type: 'pkcs8' });
  } else {
    privateKey = generateKeyPairSync('ed25519').privateKey;
    writeFileSync(signerKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  }
  const publicKey = createPublicKey(privateKey);
  return {
    keyRef,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }),
    async sign(root) {
      return { alg: 'ed25519', bytes: new Uint8Array(edSign(null, Buffer.from(root), privateKey)), keyRef };
    },
  };
}

// Resolve the Anthropic key for the CLI flow. `pangolin orch serve` is a plain
// CLI process — it does NOT auto-load ../../.env the way the `start:env` npm
// script (`tsx --env-file`) does. So fall back to reading ../../.env here, and
// strip a trailing CR (Windows .env files are often CRLF). Without this, the
// inline secret is empty → dispatches fail BEFORE a container even launches.
function resolveApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  try {
    const envPath = join(fileURLToPath(new URL('.', import.meta.url)), '../../.env');
    const m = readFileSync(envPath, 'utf8').match(/^ANTHROPIC_API_KEY=(.*)$/m);
    if (m) return m[1].trim();
  } catch { /* no .env — leave empty; the worker reports provider-failed */ }
  return '';
}

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
const signer = loadOrCreateSigner();
const anchor = new LocalAnchor(store);
const auditLog = new AuditLog({ store, signer, anchor });

const orchestrator = new PangolinOrchestrator({
  store,
  executors: {
    dispatch: new DispatchExecutor({
      client,
      target: 'local',
      workerImage,
      secrets: {
        ANTHROPIC_API_KEY: { inline: resolveApiKey() },
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
