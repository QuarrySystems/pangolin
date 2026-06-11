import { describe, it, expect } from 'vitest';
import { PangolinOrchestrator } from '../../src/orchestrator.js';
import { SqliteRunStateStore } from '../../src/runstate/sqlite.js';
import { ManualTrigger } from '../../src/triggers/manual.js';
import { AuditLog } from '../../src/audit/audit-log.js';
import { createLocalSigner, verifyEd25519 } from '../../src/audit/signer.js';
import { LocalAnchor, S3ObjectLockAnchor, type S3LockClient } from '../../src/audit/anchor.js';
import { verify } from '../../src/audit/verify.js';

function fakeExec() {
  let fired = false;
  return {
    id: 'x',
    async fire() { fired = true; return { dispatchHash: 'd' }; },
    async reconcile() { return fired ? { status: 'done' as const } : null; },
  };
}

function fakeS3(): S3LockClient {
  const m = new Map<string, Uint8Array>();
  return {
    async putObject(k: string, b: Uint8Array) { m.set(k, b); },
    async getObject(k: string) { return m.get(k); },
  };
}

async function drive(orch: PangolinOrchestrator) {
  for (let i = 0; i < 6; i++) await orch.tick('default');
}

const RUN = (id: string, inputs: Record<string, unknown> = {}) => ({
  id,
  queue: 'default',
  items: [{ id: 'a', executor: 'x', inputs, depends_on: [], resourceLocks: [] }],
});

describe('audit acceptance — §6.3/§10 end-to-end gates', () => {
  it('1. clean LocalAnchor -> intact:true, claim:tamper-detecting; ed25519 signature verifies', async () => {
    const store = new SqliteRunStateStore();
    const signer = createLocalSigner();
    const anchor = new LocalAnchor(store);
    const auditLog = new AuditLog({ store, signer, anchor });
    const orch = new PangolinOrchestrator({
      store,
      executors: { x: fakeExec() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 1 } },
      auditLog,
    });

    const runId = orch.submitRun(RUN('r1'), 'human:brett');
    await drive(orch);

    // Sanity: run sealed before verify (getAuditRoot persists the completed seal)
    expect(store.getAuditRoot(runId)).toBeDefined();

    const report = await verify(runId, {
      store,
      anchor,
      verifySignature: (root, sig) => verifyEd25519(root, sig, signer.publicKey),
    });

    expect(report.intact).toBe(true);
    expect(report.claim).toBe('tamper-detecting');
    // Signature was stored in the anchored root — verify it explicitly via the anchored root's sig
    const anchored = (await anchor.fetch({ epochId: runId }))[0];
    expect(anchored).toBeDefined();
    expect(anchored!.signature).toBeDefined();
    expect(verifyEd25519(anchored!.root, anchored!.signature!, signer.publicKey)).toBe(true);
  });

  it('2. clean S3ObjectLockAnchor (external-immutable) -> intact:true, claim:tamper-evident', async () => {
    const store = new SqliteRunStateStore();
    const signer = createLocalSigner();
    const anchor = new S3ObjectLockAnchor(fakeS3(), 'bucket');
    const auditLog = new AuditLog({ store, signer, anchor });
    const orch = new PangolinOrchestrator({
      store,
      executors: { x: fakeExec() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 1 } },
      auditLog,
    });

    const runId = orch.submitRun(RUN('r2'), 'human:brett');
    await drive(orch);

    // Sanity: run sealed before verify (getAuditRoot persists the completed seal)
    expect(store.getAuditRoot(runId)).toBeDefined();

    const report = await verify(runId, {
      store,
      anchor,
      verifySignature: (root, sig) => verifyEd25519(root, sig, signer.publicKey),
    });

    expect(report.intact).toBe(true);
    expect(report.claim).toBe('tamper-evident');
  });

  it('3. DB tamper after seal -> intact:false (chain broken, anchored root unmodified)', async () => {
    const store = new SqliteRunStateStore();
    const signer = createLocalSigner();
    const anchor = new S3ObjectLockAnchor(fakeS3(), 'bucket');
    const auditLog = new AuditLog({ store, signer, anchor });
    const orch = new PangolinOrchestrator({
      store,
      executors: { x: fakeExec() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 1 } },
      auditLog,
    });

    const runId = orch.submitRun(RUN('r3'), 'human:brett');
    await drive(orch);

    // Prove the run sealed clean BEFORE the tamper — this makes the mutation the causal agent
    const preReport = await verify(runId, { store, anchor });
    expect(preReport.intact).toBe(true);   // proves the run sealed clean

    // Mutate a persisted audit_entries row directly (bypassing the chain)
    (store as any).db
      .prepare("UPDATE audit_entries SET actor='attacker' WHERE run_id=? AND seq=0")
      .run(runId);

    // Re-verify: the DB chain is broken (actor changed, but entryHash was computed with original actor)
    // The anchored root (in S3) still holds the original root — this is the DB-tamper demo
    const report = await verify(runId, { store, anchor });
    expect(report.intact).toBe(false);     // proves the mutation broke it
  });

  it('4. no secret value in the audit export — inputs are never written to audit entries', async () => {
    const SECRET = 'super-secret-DO-NOT-LEAK';
    const store = new SqliteRunStateStore();
    const signer = createLocalSigner();
    const anchor = new LocalAnchor(store);
    const auditLog = new AuditLog({ store, signer, anchor });
    const orch = new PangolinOrchestrator({
      store,
      executors: { x: fakeExec() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 1 } },
      auditLog,
    });

    const run = RUN('r4', { token: SECRET });
    const runId = orch.submitRun(run, 'human:brett');
    await drive(orch);

    // Sanity: run sealed before verify (getAuditRoot persists the completed seal)
    expect(store.getAuditRoot(runId)).toBeDefined();

    const entries = store.getAuditEntries(runId);
    expect(entries.length).toBeGreaterThan(0);   // proves audit wiring ran
    expect(JSON.stringify(entries)).not.toContain(SECRET);
  });
});
