// pangolin.config.mjs — operator config for the claims-appeals MinIO demo.
//
// Exports:
//   default / client  — wired PangolinClient (namespace 'demo-claims-appeals')
//   orch              — OrchContext: { transport, storage, anchor, verifySignature, createOrchestrator }
//
// IMPORT-SAFE: no throw at load when ANTHROPIC_API_KEY / PANGOLIN_S3_ENDPOINT are absent.
// No SQLite opened at module level — only inside createOrchestrator() (D3 single-writer).

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';

import { S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { PangolinClient, NoopCredentialProvider, StdoutResultSink } from '@quarry-systems/pangolin-client';
import { LocalDockerProvider } from '@quarry-systems/pangolin-providers-local-docker';
import { AwsSecretStore } from '@quarry-systems/pangolin-secret-store';
import { S3StorageProvider } from '@quarry-systems/pangolin-storage-s3';
import {
  PangolinOrchestrator,
  SqliteRunStateStore,
  ManualTrigger,
  DispatchExecutor,
  AuditLog,
  S3Mailbox,
  S3ObjectLockAnchor,
  MailboxSubmissionTransport,
  verifyEd25519,
  serve,
} from '@quarry-systems/pangolin-orchestrator';

import { AwsS3MailboxClient, AwsS3LockClient } from '@quarry-systems/pangolin-storage-s3';

// ---------------------------------------------------------------------------
// Shared S3 client — built once, reused for storage + mailbox + anchor.
// Safe at module level: no I/O is performed by the SDK constructor.
// Host process defaults to localhost:9000 (MinIO on host). Worker containers
// get host.docker.internal via LocalDockerProvider extraEnv/extraHosts.
// ---------------------------------------------------------------------------
const s3 = new S3Client({
  endpoint: process.env.PANGOLIN_S3_ENDPOINT ?? 'http://localhost:9000',
  forcePathStyle: true,
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.PANGOLIN_S3_ACCESS_KEY ?? 'minioadmin',
    secretAccessKey: process.env.PANGOLIN_S3_SECRET_KEY ?? 'minioadmin',
  },
});

// Secrets Manager client for the HOST serve process — points at LocalStack so
// staging secrets never hits real AWS. (Workers get their own SM endpoint via
// LocalDockerProvider.extraEnv → host.docker.internal:4566.) Constructor does no
// I/O, so this stays import-safe.
const sm = new SecretsManagerClient({
  endpoint: process.env.AWS_ENDPOINT_URL_SECRETS_MANAGER ?? 'http://localhost:4566',
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'minioadmin',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'minioadmin',
  },
});

const workerImage = 'ghcr.io/quarrysystems/pangolin-worker:latest';

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
// Signer — in-memory key derivation only, no I/O.
// ---------------------------------------------------------------------------
// Deterministic dev signer. serve (signs the audit root) and the host driver
// (verifies it) are SEPARATE processes — a random per-process keypair would
// never verify cross-process. Derive ONE ed25519 keypair from a fixed seed
// shared via this config, so both sides match.
// Override with PANGOLIN_SIGNER_SEED_HEX (64 hex chars). DEV ONLY.
const _seedHex =
  process.env.PANGOLIN_SIGNER_SEED_HEX ??
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const _pkcs8 = Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'), // PKCS8 ed25519 prefix
  Buffer.from(_seedHex, 'hex'), // 32-byte seed
]);
const _privKey = createPrivateKey({ key: _pkcs8, format: 'der', type: 'pkcs8' });
const _pubDer = createPublicKey(_privKey).export({ type: 'spki', format: 'der' });
const signer = {
  keyRef: 'claims-appeals-dev',
  publicKey: _pubDer,
  async sign(root) {
    return {
      alg: 'ed25519',
      bytes: new Uint8Array(edSign(null, Buffer.from(root), _privKey)),
      keyRef: 'claims-appeals-dev',
    };
  },
};

/** Verify an ed25519 signature against the shared dev public key. */
const verifySignature = (root, sig) => verifyEd25519(root, sig, signer.publicKey);

// ---------------------------------------------------------------------------
// Triggers + queues (shared between factory and client)
// ---------------------------------------------------------------------------
const triggers = { manual: new ManualTrigger() };
const queues = { default: { concurrency: 2 } };

// ---------------------------------------------------------------------------
// PangolinClient — lazy: no Docker / network until dispatch fires.
// ---------------------------------------------------------------------------
export const client = new PangolinClient({
  namespace: 'demo-claims-appeals',
  compute: {
    'local-docker': new LocalDockerProvider({
      allowUnpinnedImage: true,
      // Sibling workers must resolve host.docker.internal to reach MinIO on the host.
      // Docker Desktop injects it automatically; native Linux needs host-gateway.
      extraHosts: ['host.docker.internal:host-gateway'],
      extraEnv: {
        // S3 (MinIO) storage bootstrap — workers use host.docker.internal, not localhost.
        PANGOLIN_S3_ENDPOINT: process.env.PANGOLIN_S3_ENDPOINT
          ? process.env.PANGOLIN_S3_ENDPOINT.replace('localhost', 'host.docker.internal')
          : 'http://host.docker.internal:9000',
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? process.env.PANGOLIN_S3_ACCESS_KEY ?? 'minioadmin',
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? process.env.PANGOLIN_S3_SECRET_KEY ?? 'minioadmin',
        AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
        // Secrets Manager (LocalStack) endpoint so worker's AwsSecretStore resolves cross-container.
        AWS_ENDPOINT_URL_SECRETS_MANAGER:
          process.env.AWS_ENDPOINT_URL_SECRETS_MANAGER ?? 'http://host.docker.internal:4566',
      },
    }),
  },
  storage,
  // AwsSecretStore against LocalStack Secrets Manager. ANTHROPIC_API_KEY and
  // PAYER_PORTAL_TOKEN are staged per-dispatch (ref-only in audit, log-redacted).
  // Host serve stages into LocalStack — point the SM client there explicitly
  // (mirrors the S3 client) so host serve never hits real AWS. LocalStack is on
  // 4566 (not remapped with MinIO); accepts any creds.
  secretStores: { aws: new AwsSecretStore({ client: sm }) },
  credentials: { none: new NoopCredentialProvider() },
  targets: { local: { compute: 'local-docker', credentials: 'none', secretStore: 'aws' } },
  resultSink: new StdoutResultSink(),
});

export default client;

// ---------------------------------------------------------------------------
// Executors — constructed lazily inside createOrchestrator so they close
// over the client defined above; still safe at module level since
// DispatchExecutor does no I/O until fire() is called.
//
// NOTE: executor key MUST be 'dispatch' — plan.json items use executor:"dispatch".
// ---------------------------------------------------------------------------
function makeExecutors() {
  const opts = {
    client,
    target: 'local',
    workerImage,
    secrets: {
      ANTHROPIC_API_KEY: { inline: process.env.ANTHROPIC_API_KEY ?? '' },
      // Synthetic portal token for Beat 2's redaction demo — shows even when unset.
      PAYER_PORTAL_TOKEN: {
        inline: process.env.PAYER_PORTAL_TOKEN ?? 'sk-payer-DEMO-not-a-real-token',
      },
    },
  };
  return {
    dispatch: new DispatchExecutor(opts),
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
    process.env.PANGOLIN_DB_PATH ?? join(tmpdir(), 'pangolin-claims.db'),
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

// `pangolin orch serve` (host-side) calls orch.runService(signal). It opens the
// single-writer orchestrator (createOrchestrator → the sole SQLite owner) and
// drives the S3 mailbox. The audit/verify CLIs read the anchor from S3 (Object
// Lock), not this local DB, so they work cross-process without sharing it.
const runService = (signal) => serve({ orchestrator: createOrchestrator(), transport, signal });

export const orch = {
  transport,
  anchor,
  storage,
  verifySignature,
  createOrchestrator,
  runService,
};
