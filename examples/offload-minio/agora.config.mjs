// agora.config.mjs — operator config for the Tier-1 MinIO proof.
//
// Exports:
//   default / client  — wired AgoraClient (namespace 'offload-minio')
//   orch              — OrchContext: { transport, storage, anchor, verifySignature, createOrchestrator }
//
// IMPORT-SAFE: no throw at load when ANTHROPIC_API_KEY / AGORA_S3_ENDPOINT are absent.
// No SQLite opened at module level — only inside createOrchestrator() (D3 single-writer).

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { S3Client } from '@aws-sdk/client-s3';
import { AgoraClient, NoopCredentialProvider, StdoutResultSink } from '@quarry-systems/agora-client';
import { LocalDockerProvider } from '@quarry-systems/agora-providers-local-docker';
import { LocalSecretStore } from '@quarry-systems/agora-secret-store';
import { S3StorageProvider } from '@quarry-systems/agora-storage-s3';
import {
  AgoraOrchestrator,
  SqliteRunStateStore,
  ManualTrigger,
  DispatchExecutor,
  AuditLog,
  S3Mailbox,
  S3ObjectLockAnchor,
  MailboxSubmissionTransport,
  createLocalSigner,
  verifyEd25519,
} from '@quarry-systems/agora-orchestrator';

import { AwsS3MailboxClient } from './src/aws-s3-mailbox-client.js';
import { AwsS3LockClient } from './src/aws-s3-lock-client.js';

// ---------------------------------------------------------------------------
// Shared S3 client — built once, reused for storage + mailbox + anchor.
// Safe at module level: no I/O is performed by the SDK constructor.
// ---------------------------------------------------------------------------
const s3 = new S3Client({
  endpoint: process.env.AGORA_S3_ENDPOINT,
  forcePathStyle: true,
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.AGORA_S3_ACCESS_KEY ?? 'minioadmin',
    secretAccessKey: process.env.AGORA_S3_SECRET_KEY ?? 'minioadmin',
  },
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const secretDir = join(tmpdir(), 'agora-minio-secrets');
const workerImage = 'ghcr.io/quarrysystems/agora-worker:latest';

// ---------------------------------------------------------------------------
// Storage, transport, and anchor — safe at module level (constructors only).
// ---------------------------------------------------------------------------
const storage = new S3StorageProvider({ bucket: 'agora-data', client: s3 });

const transport = new MailboxSubmissionTransport(
  new S3Mailbox(
    new AwsS3MailboxClient({ client: s3, bucket: 'agora-data', prefix: 'mailbox/' }),
  ),
);

const anchor = new S3ObjectLockAnchor(
  new AwsS3LockClient({ client: s3, bucket: 'agora-audit' }),
  'agora-audit',
);

// ---------------------------------------------------------------------------
// Signer — in-memory key generation only, no I/O.
// ---------------------------------------------------------------------------
const signer = createLocalSigner();

/** Verify an ed25519 signature produced by our local signer. */
const verifySignature = (root, sig) => verifyEd25519(root, sig, signer.publicKey);

// ---------------------------------------------------------------------------
// Triggers + queues (shared between factory and client)
// ---------------------------------------------------------------------------
const triggers = { manual: new ManualTrigger() };
const queues = { default: { concurrency: 2 } };

// ---------------------------------------------------------------------------
// AgoraClient — lazy: no Docker / network until dispatch fires.
// ---------------------------------------------------------------------------
export const client = new AgoraClient({
  namespace: 'offload-minio',
  compute: {
    'local-docker': new LocalDockerProvider({
      allowUnpinnedImage: true,
      extraEnv: {
        AGORA_S3_ENDPOINT: process.env.AGORA_S3_ENDPOINT ?? '',
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? process.env.AGORA_S3_ACCESS_KEY ?? 'minioadmin',
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? process.env.AGORA_S3_SECRET_KEY ?? 'minioadmin',
        AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
      },
    }),
  },
  storage,
  secretStores: { local: new LocalSecretStore({ dir: secretDir }) },
  credentials: { none: new NoopCredentialProvider() },
  targets: { local: { compute: 'local-docker', credentials: 'none', secretStore: 'local' } },
  resultSink: new StdoutResultSink(),
});

export default client;

// ---------------------------------------------------------------------------
// Executors — constructed lazily inside createOrchestrator so they close
// over the client defined above; still safe at module level since
// DispatchExecutor does no I/O until fire() is called.
// ---------------------------------------------------------------------------
function makeExecutors() {
  const opts = {
    client,
    target: 'local',
    workerImage,
    secrets: {
      ANTHROPIC_API_KEY: { inline: process.env.ANTHROPIC_API_KEY ?? '' },
    },
  };
  return {
    'dispatch-a': new DispatchExecutor(opts),
    'dispatch-b': new DispatchExecutor(opts),
  };
}

// ---------------------------------------------------------------------------
// CRITICAL (D3 single-writer): SqliteRunStateStore is ONLY opened inside this
// factory. The serve container calls createOrchestrator(); the host driver uses
// orch.transport / orch.anchor / orch.storage / orch.verifySignature directly.
// Importing this module does NOT create or open any .db file.
// ---------------------------------------------------------------------------
function createOrchestrator() {
  const store = new SqliteRunStateStore(
    process.env.AGORA_DB_PATH ?? join(tmpdir(), 'agora-minio.db'),
  );
  const auditLog = new AuditLog({ store, signer, anchor });
  return new AgoraOrchestrator({
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
