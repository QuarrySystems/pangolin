// deploy/serve-stack/client/pangolin.config.mjs — the laptop kit (spec §3).
//
// Loaded by the plain-node `pangolin` bin (registration verbs, orch submit/watch/
// render/audit, verify) and by client/smoke.mjs. Talks to the always-on stack
// THROUGH THE SSH TUNNEL: only port 9000 (MinIO) is forwarded — 4566
// (LocalStack) is serve/worker-side and never needed here.
//
// Exports:
//   default / client  — PangolinClient (namespace 'serve-stack' — MUST match the
//                       serve config so registered capabilities/subagents
//                       resolve on dispatch)
//   orch              — { transport, storage, anchor, verifySignature }
//
// NO ANTHROPIC KEY ANYWHERE: the key lives in the host's .env and is staged
// per-dispatch by the serve container (refs-only in the audit). The laptop
// only registers, submits, watches, and verifies.
//
// IMPORT-SAFE: constructors only at module level; verifySignature reads the
// fetched public-key.json lazily and returns false when it is absent.

import { readFileSync } from 'node:fs';

import { S3Client } from '@aws-sdk/client-s3';
import { PangolinClient } from '@quarry-systems/pangolin-client';
import {
  S3StorageProvider,
  AwsS3MailboxClient,
  AwsS3LockClient,
} from '@quarry-systems/pangolin-storage-s3';
import {
  S3Mailbox,
  S3ObjectLockAnchor,
  MailboxSubmissionTransport,
  verifyEd25519,
} from '@quarry-systems/pangolin-orchestrator';

// ---------------------------------------------------------------------------
// Shared S3 client — the tunneled MinIO endpoint (ssh -L 9000:localhost:9000).
// Same env override as the serve side for non-default setups.
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
// verifySignature — against the FETCHED public key (the #55 verify-context
// shape). The serve container publishes s3://pangolin-data/public-key.json on
// every start; the runbook's laptop-setup step downloads it next to this file.
// Lazy + forgiving: absent / unreadable file ⇒ false (import never throws).
// ---------------------------------------------------------------------------
const PUBLIC_KEY_URL = new URL('./public-key.json', import.meta.url);

const verifySignature = (root, sig) => {
  try {
    const { spkiDer } = JSON.parse(readFileSync(PUBLIC_KEY_URL, 'utf8'));
    return verifyEd25519(root, sig, Buffer.from(spkiDer, 'base64'));
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// PangolinClient — registration verbs (capabilities/subagent register) + storage.
// No compute / no targets: the laptop never dispatches workers — the serve
// container does. Namespace MUST equal the serve config's.
// ---------------------------------------------------------------------------
export const client = new PangolinClient({
  namespace: 'serve-stack',
  compute: {},
  credentials: {},
  storage,
  targets: {},
});

export default client;

export const orch = {
  transport,
  storage,
  anchor,
  verifySignature,
};
