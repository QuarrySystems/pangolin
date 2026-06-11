// deploy/serve-stack/pangolin.config.mjs — serve-side operator config (always-on stack).
//
// Exports:
//   default / client  — wired PangolinClient (namespace 'serve-stack')
//   orch              — OrchContext: { transport, storage, anchor, verifySignature, createOrchestrator }
//
// IMPORT-SAFE: no throw at load when ANTHROPIC_API_KEY / PANGOLIN_S3_ENDPOINT are absent.
// No SQLite opened at module level — only inside createOrchestrator() (D3 single-writer).
// No filesystem I/O at module level either — the persisted signer seed is read /
// created lazily inside getSigner() (first call from createOrchestrator() or
// verifySignature()), matching the example's import-safety posture.
//
// Deltas from examples/offload-minio/pangolin.config.mjs (spec §3, audit-pinned):
//   - Persisted signer seed (/data volume) instead of the deterministic dev seed.
//   - Public key published to s3://pangolin-data/public-key.json on serve start.
//   - workerImage pinned to ghcr.io/quarrysystems/pangolin-worker:main (never :latest).
//   - A dedicated `gated` queue carrying the pipeline pattern; `default` stays patternless.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { PangolinClient, NoopCredentialProvider, StdoutResultSink } from '@quarry-systems/pangolin-client';
import { LocalDockerProvider } from '@quarry-systems/pangolin-providers-local-docker';
import { AwsSecretStore } from '@quarry-systems/pangolin-secret-store';
import {
  S3StorageProvider,
  AwsS3MailboxClient,
  AwsS3LockClient,
} from '@quarry-systems/pangolin-storage-s3';
import {
  PangolinOrchestrator,
  SqliteRunStateStore,
  ManualTrigger,
  DispatchExecutor,
  AuditLog,
  S3Mailbox,
  S3ObjectLockAnchor,
  MailboxSubmissionTransport,
  pipeline,
  verifyEd25519,
} from '@quarry-systems/pangolin-orchestrator';

// ---------------------------------------------------------------------------
// Shared S3 client — built once, reused for storage + mailbox + anchor +
// public-key publication. Safe at module level: no I/O in the SDK constructor.
// ---------------------------------------------------------------------------
const s3 = new S3Client({
  endpoint: process.env.PANGOLIN_S3_ENDPOINT,
  forcePathStyle: true,
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.PANGOLIN_S3_ACCESS_KEY ?? 'minioadmin',
    secretAccessKey: process.env.PANGOLIN_S3_SECRET_KEY ?? 'minioadmin',
  },
});

// Pinned GHCR tag — explicitly NOT ':latest' (spec audit #1; ':main' is mutable,
// true digest pinning is the deferred imageDigest item).
const workerImage = 'ghcr.io/quarrysystems/pangolin-worker:main';

// ---------------------------------------------------------------------------
// Storage, transport, and anchor — safe at module level (constructors only).
// ---------------------------------------------------------------------------
const storage = new S3StorageProvider({ bucket: 'pangolin-data', client: s3 });

const transport = new MailboxSubmissionTransport(
  new S3Mailbox(
    new AwsS3MailboxClient({ client: s3, bucket: 'pangolin-data', prefix: 'mailbox/' }),
  ),
);

const anchor = new S3ObjectLockAnchor(
  new AwsS3LockClient({ client: s3, bucket: 'pangolin-audit' }),
  'pangolin-audit',
);

// ---------------------------------------------------------------------------
// Signer — persisted keypair (spec S5, audit #3). NOT the example's
// deterministic dev seed: first boot generates a random 32-byte seed and
// persists it (mode 0600) on the serve volume; every later boot reads it back
// and rebuilds the same ed25519 keypair via the example's own PKCS8/SPKI
// construction (pangolin.config.mjs:77-92 in offload-minio). Lazy: file I/O only
// on first use, never at import time.
// ---------------------------------------------------------------------------
const SIGNER_KEY_REF = 'serve-stack-persisted';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

let _signer;
/**
 * Load-or-create the persisted ed25519 signer (exported as the minimal test
 * seam: lets a harness exercise the seed round-trip and sign/verify agreement
 * without booting the orchestrator). Still lazy — no I/O until first call.
 */
export function getSigner() {
  if (_signer) return _signer;
  const seedPath = process.env.PANGOLIN_SIGNER_SEED_PATH ?? '/data/signer-seed.hex';
  let seed;
  if (existsSync(seedPath)) {
    seed = Buffer.from(readFileSync(seedPath, 'utf8').trim(), 'hex');
    if (seed.length !== 32) {
      throw new Error(`[config] signer seed at ${seedPath} is not 32 bytes — refusing to sign with a corrupt key`);
    }
  } else {
    seed = randomBytes(32);
    writeFileSync(seedPath, seed.toString('hex'), { mode: 0o600 });
  }
  const pkcs8 = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const privKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const pubDer = createPublicKey(privKey).export({ type: 'spki', format: 'der' });
  _signer = {
    keyRef: SIGNER_KEY_REF,
    publicKey: pubDer,
    async sign(root) {
      return {
        alg: 'ed25519',
        bytes: new Uint8Array(edSign(null, Buffer.from(root), privKey)),
        keyRef: SIGNER_KEY_REF,
      };
    },
  };
  return _signer;
}

// Publish the PUBLIC key so the laptop can verify bundles remotely (spec
// audit #4): raw PutObjectCommand — storage.put rejects arbitrary keys.
// Idempotent overwrite on every serve start.
async function publishPublicKey(signer) {
  await s3.send(new PutObjectCommand({
    Bucket: 'pangolin-data',
    Key: 'public-key.json',
    Body: JSON.stringify({
      keyRef: signer.keyRef,
      alg: 'ed25519',
      spkiDer: Buffer.from(signer.publicKey).toString('base64'),
    }),
  }));
}

/** Verify an ed25519 signature against the persisted public key (lazy-inits the signer). */
const verifySignature = (root, sig) => verifyEd25519(root, sig, getSigner().publicKey);

// ---------------------------------------------------------------------------
// Triggers + queues. The pipeline pattern lives ONLY on the dedicated `gated`
// queue (spec audit #8): it auto-chains empty-depends_on items, which on
// `default` would silently serialize ordinary fan-out plans.
// ---------------------------------------------------------------------------
const triggers = { manual: new ManualTrigger() };
const queues = {
  default: { concurrency: 2 },
  gated: { concurrency: 2, pattern: pipeline },
};

// ---------------------------------------------------------------------------
// PangolinClient — lazy: no Docker / network until dispatch fires.
// ---------------------------------------------------------------------------
export const client = new PangolinClient({
  namespace: 'serve-stack',
  compute: {
    'local-docker': new LocalDockerProvider({
      allowUnpinnedImage: true,
      // Sibling workers must resolve host.docker.internal to reach MinIO +
      // LocalStack on the host. Docker Desktop injects it automatically; native
      // Linux needs this host-gateway mapping (the serve container gets it via
      // compose extra_hosts, but the workers it launches do not).
      extraHosts: ['host.docker.internal:host-gateway'],
      extraEnv: {
        // S3 (MinIO) storage bootstrap — needed at worker boot, before bundles.
        PANGOLIN_S3_ENDPOINT: process.env.PANGOLIN_S3_ENDPOINT ?? '',
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? process.env.PANGOLIN_S3_ACCESS_KEY ?? 'minioadmin',
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? process.env.PANGOLIN_S3_SECRET_KEY ?? 'minioadmin',
        AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
        // Secrets Manager (LocalStack) endpoint so the worker's AwsSecretStore
        // resolves per-dispatch secret refs cross-container. The AWS SDK honors
        // AWS_ENDPOINT_URL_SECRETS_MANAGER natively — no worker code change.
        AWS_ENDPOINT_URL_SECRETS_MANAGER:
          process.env.AWS_ENDPOINT_URL_SECRETS_MANAGER ?? 'http://host.docker.internal:4566',
      },
    }),
  },
  storage,
  // AwsSecretStore against LocalStack Secrets Manager (endpoint via
  // AWS_ENDPOINT_URL_SECRETS_MANAGER on serve + worker). The ANTHROPIC_API_KEY is
  // staged here as a per-dispatch secret (ref-only in audit, log-redacted) and
  // resolved by the worker over the network — the proper secret lane, not a
  // bundle value.
  secretStores: { aws: new AwsSecretStore() },
  credentials: { none: new NoopCredentialProvider() },
  targets: { local: { compute: 'local-docker', credentials: 'none', secretStore: 'aws' } },
  resultSink: new StdoutResultSink(),
});

export default client;

// ---------------------------------------------------------------------------
// Executors — constructed lazily inside createOrchestrator so they close
// over the client defined above; still safe at module level since
// DispatchExecutor does no I/O until fire() is called.
// ---------------------------------------------------------------------------
function makeExecutors() {
  // ANTHROPIC_API_KEY is staged per-dispatch through the target's AwsSecretStore
  // (LocalStack Secrets Manager). serve stages it → an ARN ref travels to the
  // worker → the worker resolves it over the network and the value is injected +
  // log-redacted, recorded refs-only in the audit. serve reads ANTHROPIC_API_KEY
  // from its env_file; the laptop never holds it.
  const opts = {
    client,
    target: 'local',
    workerImage,
    secrets: { ANTHROPIC_API_KEY: { inline: process.env.ANTHROPIC_API_KEY ?? '' } },
  };
  return {
    'dispatch-a': new DispatchExecutor(opts),
    'dispatch-b': new DispatchExecutor(opts),
  };
}

// ---------------------------------------------------------------------------
// CRITICAL (D3 single-writer): SqliteRunStateStore is ONLY opened inside this
// factory. The serve container calls createOrchestrator(); the laptop client
// uses orch.transport / orch.anchor / orch.storage / orch.verifySignature via
// client/pangolin.config.mjs. Importing this module does NOT create or open any
// .db file, nor touch the signer seed file.
// ---------------------------------------------------------------------------
function createOrchestrator() {
  const signer = getSigner();
  // Serve start = the publication point. Fire-and-forget: the put is an
  // idempotent overwrite and a transient failure must not block the loop —
  // it is retried implicitly on the next serve (re)start.
  void publishPublicKey(signer).catch((err) => {
    console.error('[config] public-key publication failed (laptop verify will lack the key):', err);
  });
  const store = new SqliteRunStateStore(
    process.env.PANGOLIN_DB_PATH ?? join(tmpdir(), 'pangolin-serve-stack.db'),
  );
  const auditLog = new AuditLog({ store, signer, anchor });
  return new PangolinOrchestrator({
    store,
    executors: makeExecutors(),
    triggers,
    queues,
    auditLog,
  });
}

export const orch = {
  transport,
  anchor,
  storage,
  verifySignature,
  createOrchestrator,
};
