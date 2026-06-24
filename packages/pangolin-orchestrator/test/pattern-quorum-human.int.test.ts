// End-to-end proof of the OVERSIGHT / FOUR-EYES tier: a quorum of 2 AI reviewers + 1
// HumanApprovalExecutor, threshold 3 (unanimous incl. the human), onReject 'block'.
// Drives the real engine + quorum pattern; the human verdict gates the effecting commit.
import { describe, it, expect } from 'vitest';
import { SqliteRunStateStore } from '../src/runstate/sqlite.js';
import { quorum } from '../src/patterns/quorum.js';
import {
  HumanApprovalExecutor,
  type ApprovalDecision,
  type ApprovalSource,
} from '../src/executors/human-approval.js';
import { assembleBundle } from '../src/audit/bundle.js';
import { verifyBundle } from '../src/audit/verify-bundle.js';
import {
  idKeyedExecutor,
  makeOrch,
  driveUntilDone,
  storageFromBlobs,
  type ItemBehavior,
} from './fixtures/pattern-harness.js';
import type { Run } from '../src/contracts/index.js';

const REF_DRAFT = 'pangolin://ns/artifact/draft/sha256:' + 'a'.repeat(64);
const REF_COMMIT = 'pangolin://ns/artifact/commit/sha256:' + 'b'.repeat(64);

function behavior(itemId: string): ItemBehavior {
  if (itemId === 'draft') return { status: 'done', resultRef: REF_DRAFT };
  if (itemId === 'draft::rev-0') return { status: 'done', verify: { passed: true } };
  if (itemId === 'draft::rev-1') return { status: 'done', verify: { passed: true } };
  if (itemId === 'draft::commit') return { status: 'done', resultRef: REF_COMMIT };
  return { status: 'done' }; // draft::rev-2 is handled by the human executor, not this one
}

// An auto-deciding source — simulates a human who has already decided by the time reconcile polls.
const fixedSource = (decision: ApprovalDecision): ApprovalSource => ({ poll: () => decision });

function fourEyesRun(): Run {
  return {
    id: 'r1',
    queue: 'default',
    items: [
      {
        id: 'draft',
        executor: 'dispatch',
        inputs: {
          quorum: {
            reviewers: [
              { executor: 'dispatch', inputs: {} }, // AI reviewer
              { executor: 'dispatch', inputs: {} }, // AI reviewer
              { executor: 'human-approval', inputs: { approverRole: 'compliance-officer' } }, // human
            ],
            threshold: 3, // unanimous — the human sign-off is mandatory
            commit: { executor: 'dispatch', inputs: {} },
            onReject: 'block',
          },
        },
        depends_on: [],
        resourceLocks: [],
      },
    ],
  };
}

describe('quorum + human-approval (four-eyes tier)', () => {
  it('a human approval completes the quorum, advancing the commit; the run seals and verifies', async () => {
    const store = new SqliteRunStateStore();
    try {
      const blobs = new Map<string, Uint8Array>();
      const human = new HumanApprovalExecutor({
        source: fixedSource({
          approver: 'human:alice',
          decision: 'approve',
          decidedAt: '2026-06-24T10:00:00.000Z',
        }),
        sink: { put: (ref, bytes) => void blobs.set(ref, bytes) },
        namespace: 'ns',
      });
      const { orch, anchor } = makeOrch(store, idKeyedExecutor(blobs, behavior), {
        executors: { 'human-approval': human },
        queues: { default: { concurrency: 5, pattern: quorum } },
        maxAttempts: 1,
      });

      const runId = await orch.submitRun(fourEyesRun(), 'human:submitter');
      await driveUntilDone(orch, 64, runId);

      const byId = new Map(orch.getStatus(runId).map((s) => [s.id, s]));
      expect(byId.get('draft::rev-2')?.status).toBe('done');
      expect(byId.get('draft::rev-2')?.verify?.passed).toBe(true); // the human approved
      expect(byId.get('draft::commit')?.status).toBe('done'); // 3/3 → commit advanced

      const exp = orch.getAuditExport(runId);
      expect(exp.root).toBeDefined(); // sealed

      const bundle = await assembleBundle(exp, { anchor, storage: storageFromBlobs(blobs) });
      const report = await verifyBundle(bundle, { anchor });
      expect(report.intact).toBe(true);
      expect(report.checks.handoff.ok).toBe(true);
    } finally {
      store.close();
    }
  });

  it('a human rejection blocks the commit — the effecting step never runs (segregation of duties)', async () => {
    const store = new SqliteRunStateStore();
    try {
      const blobs = new Map<string, Uint8Array>();
      const human = new HumanApprovalExecutor({
        source: fixedSource({
          approver: 'human:bob',
          decision: 'reject',
          decidedAt: '2026-06-24T11:00:00.000Z',
          reason: 'insufficient evidence',
        }),
        sink: { put: (ref, bytes) => void blobs.set(ref, bytes) },
        namespace: 'ns',
      });
      const { orch } = makeOrch(store, idKeyedExecutor(blobs, behavior), {
        executors: { 'human-approval': human },
        queues: { default: { concurrency: 5, pattern: quorum } },
        maxAttempts: 1,
      });

      const runId = await orch.submitRun(fourEyesRun(), 'human:submitter');
      await driveUntilDone(orch, 64, runId);

      const byId = new Map(orch.getStatus(runId).map((s) => [s.id, s]));
      expect(byId.get('draft::rev-2')?.verify?.passed).toBe(false); // the human rejected
      expect(byId.has('draft::commit')).toBe(false); // 2/3 < threshold → blocked
      expect(orch.getAuditExport(runId).root).toBeDefined(); // still seals (all items terminal)
    } finally {
      store.close();
    }
  });
});
