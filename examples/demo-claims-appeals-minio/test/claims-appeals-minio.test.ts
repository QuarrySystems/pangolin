// Proves only that the SHIPPED EXAMPLE ARTIFACTS compose and run. Deep mechanics
// (lock fan-out, audit verify, DB-tamper-fails, no-secret-in-export, guarantee tier,
// MinIO/Object-Lock path) are owned by integration tests and NOT re-tested here.
// The MinIO/S3 path is exercised manually (not here).

import { describe, it, expect } from 'vitest';
import {
  PangolinOrchestrator,
  SqliteRunStateStore,
  ManualTrigger,
  AuditLog,
  NoneSigner,
  LocalAnchor,
} from '@quarry-systems/pangolin-orchestrator';
import type { Run, Executor, FireContext, ItemStatus } from '@quarry-systems/pangolin-orchestrator';
import plan from '../plan.json' assert { type: 'json' };

// ---------------------------------------------------------------------------
// Local helper: drive a real PangolinOrchestrator + fake executor to terminal.
// Mirrors the inline loop in demo-claims-appeals/test/claims-appeals.test.ts.
// ---------------------------------------------------------------------------
async function driveToTerminal(rawPlan: Run): Promise<ItemStatus[]> {
  const fakeExecutor: Executor = {
    id: 'dispatch',
    async fire(item, _ctx?: FireContext) {
      const dispatchHash = 'dh-' + item.id;
      const manifestRef = 'pangolin://manifests/' + dispatchHash;
      return { dispatchHash, manifestRef };
    },
    async reconcile(h: string) {
      return { status: 'done' as const, output: { exitCode: 0 }, resultRef: 'pangolin://artifacts/' + h };
    },
  };

  const store = new SqliteRunStateStore();
  try {
    const anchor = new LocalAnchor(store);
    const auditLog = new AuditLog({ store, signer: NoneSigner, anchor });
    const orchestrator = new PangolinOrchestrator({
      store,
      executors: { dispatch: fakeExecutor },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 2 } },
      auditLog,
    });

    const runId = orchestrator.submitRun(rawPlan, 'human:test');

    for (let i = 0; i < 20; i++) {
      await orchestrator.tick('default');
      const statuses = orchestrator.getStatus(runId);
      const allTerminal = statuses.every((s) =>
        ['done', 'failed', 'skipped', 'cancelled'].includes(s.status),
      );
      if (allTerminal && statuses.length === rawPlan.items.length) break;
    }

    return orchestrator.getStatus(runId);
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('demo-claims-appeals-minio example', () => {
  it('plan.json has 3 per-output-locked appeals gating one verify', () => {
    const appeals = plan.items.filter((i) => i.id.startsWith('appeal-'));
    expect(appeals).toHaveLength(3);
    appeals.forEach((a) => expect(a.resourceLocks).toHaveLength(1));
    const verify = plan.items.find((i) => i.id === 'verify');
    expect(verify!.depends_on).toEqual(['appeal-001', 'appeal-002', 'appeal-003']);
  });

  it('a real orchestrator drives the plan to done via a fake executor', async () => {
    const items = await driveToTerminal(plan as unknown as Run);
    expect(items).toHaveLength(plan.items.length);
    expect(
      items.filter((i) => i.id.startsWith('appeal-')).every((i) => i.status === 'done' && i.resultRef),
    ).toBe(true);
    expect(items.find((i) => i.id === 'verify')?.status).toBe('done');
  });
});
