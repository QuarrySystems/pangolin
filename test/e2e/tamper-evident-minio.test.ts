import { describe, it, expect } from 'vitest';
// `@aws-sdk/client-s3` is not a root dependency (pnpm strict, no hoist). Import the raw
// SDK primitives through storage-s3's own node_modules (it declares the dep) — the same
// pattern test/e2e/mcp-tool-surface.test.ts uses for the MCP SDK. This keeps the SDK OUT
// of storage-s3's public API (the package's job is to encapsulate it, not re-export it).
import {
  S3Client,
  CreateBucketCommand,
} from '../../packages/pangolin-storage-s3/node_modules/@aws-sdk/client-s3';
import { AwsS3LockClient } from '../../packages/pangolin-storage-s3/src/index.js';
import { PangolinOrchestrator } from '../../packages/pangolin-orchestrator/src/orchestrator.js';
import { SqliteRunStateStore } from '../../packages/pangolin-orchestrator/src/runstate/sqlite.js';
import { ManualTrigger } from '../../packages/pangolin-orchestrator/src/triggers/manual.js';
import { AuditLog } from '../../packages/pangolin-orchestrator/src/audit/audit-log.js';
import {
  createLocalSigner,
  verifyEd25519,
} from '../../packages/pangolin-orchestrator/src/audit/signer.js';
import { S3ObjectLockAnchor } from '../../packages/pangolin-orchestrator/src/audit/anchor.js';
import { verify } from '../../packages/pangolin-orchestrator/src/audit/verify.js';
import { canonEntry } from '../../packages/pangolin-orchestrator/src/audit/canon.js';
import {
  chainHash,
  merkleRoot,
  leavesFromEntryHashes,
} from '../../packages/pangolin-orchestrator/src/audit/merkle.js';

const d = process.env.PANGOLIN_S3_ENDPOINT ? describe : describe.skip;
const MINIO = process.env.PANGOLIN_S3_ENDPOINT;

function fakeExec() {
  let fired = false;
  return {
    id: 'x',
    async fire() {
      fired = true;
      return { dispatchHash: 'd' };
    },
    async reconcile() {
      return fired ? { status: 'done' as const } : null;
    },
  };
}

d('real S3 Object Lock (tamper-evident readiness)', () => {
  it('clean run -> tamper-evident; chain-consistent forge -> root-mismatch', async () => {
    const client = new S3Client({
      endpoint: MINIO,
      forcePathStyle: true,
      region: 'us-east-1',
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    });
    await client
      .send(new CreateBucketCommand({ Bucket: 'pangolin-audit', ObjectLockEnabledForBucket: true }))
      .catch(() => {});

    const store = new SqliteRunStateStore();
    const signer = createLocalSigner();
    const anchor = new S3ObjectLockAnchor(
      new AwsS3LockClient({ client, bucket: 'pangolin-audit' }),
      'pangolin-audit',
    );
    const auditLog = new AuditLog({ store, signer, anchor });
    const orch = new PangolinOrchestrator({
      store,
      executors: { x: fakeExec() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 1 } },
      auditLog,
    });

    const runId = await orch.submitRun(
      {
        id: `tev-${Date.now()}`,
        queue: 'default',
        items: [{ id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }],
      },
      'human:brett',
    );
    for (let i = 0; i < 6; i++) await orch.tick('default');
    expect(store.getAuditRoot(runId)).toBeDefined();

    // 1. Clean run against a REAL immutable anchor -> tamper-evident.
    const clean = await verify(runId, {
      store,
      anchor,
      verifySignature: (r, s) => verifyEd25519(r, s, signer.publicKey),
    });
    expect(clean.intact).toBe(true);
    expect(clean.claim).toBe('tamper-evident');

    // 2. Chain-consistent forge in the run DB: rewrite seq 0's actor, recompute entry_hash with
    //    the REAL primitives, then relink EVERY subsequent entry so the chain re-verifies (root
    //    will differ). A clean single-item run produces FOUR entries — run.submitted (seq 0),
    //    item.fired (seq 1), item.reconciled (seq 2), run.completed (seq 3) — so we must relink
    //    the whole tail, not just seq 1.
    const db = (store as any).db;
    const rows = store.getAuditEntries(runId); // camelCase rows ordered by seq; >= 2
    const forged = [{ ...rows[0], actor: 'attacker' }, ...rows.slice(1)];
    let prev = '';
    for (let i = 0; i < forged.length; i++) {
      const e = forged[i] as any;
      const entryHash = chainHash(canonEntry(e), prev);
      db.prepare(
        'UPDATE audit_entries SET actor=?, prev_hash=?, entry_hash=? WHERE run_id=? AND seq=?',
      ).run(e.actor ?? null, prev, entryHash, runId, e.seq);
      prev = entryHash;
    }

    // 3. Attacker re-anchors the forged root. S3 Object Lock does NOT reject a new version —
    //    this PUT SUCCEEDS and becomes the LATEST version. The locked original survives as an
    //    older version, and the anchor reads the EARLIEST (locked) version, so the forgery is
    //    ignored at fetch time. (A latest-version read here would be defeated — that was the bug.)
    const forgedRoot = merkleRoot(
      leavesFromEntryHashes(store.getAuditEntries(runId).map((e) => e.entryHash)),
    );
    await anchor.anchor({ epochId: runId, root: forgedRoot });

    // 4. Re-verify -> fetches the IMMUTABLE original anchored root from S3, finds the mismatch.
    const tampered = await verify(runId, { store, anchor });
    expect(tampered.checks.chain.ok).toBe(true); // chain stayed consistent (relinked)
    expect(tampered.failure).toBe('root-mismatch'); // caught: recomputed forged root != locked original
    expect(tampered.intact).toBe(false);
    expect(tampered.claim).toBe('tamper-detecting');
  });
});
