// packages/agora-orchestrator/test/pattern-dogfood.int.test.ts
//
// End-to-end offline proof of the gated circle-back (spec §9): implement → review(gate) → package
// on the pipeline pattern, with deterministic red/green keyed by item id.

import { describe, it, expect } from 'vitest';
import { SqliteRunStateStore } from '../src/runstate/sqlite.js';
import { idKeyedExecutor, makeOrch, driveUntilDone, storageFromBlobs } from './fixtures/pattern-harness.js';
import { pipeline } from '../src/patterns/pipeline.js';
import { assembleBundle } from '../src/audit/bundle.js';
import { verifyBundle } from '../src/audit/verify-bundle.js';
import { LocalAnchor } from '../src/audit/anchor.js';
import type { WorkItem } from '../src/contracts/index.js';
import type { GateConfig } from '../src/contracts/pattern.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The product that 'implement' produces (a patch artifact). */
const REF_IMPL =
  'agora://ns/artifact/impl/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** The product that 'review-fix-1' produces (the fixed patch artifact). */
const REF_FIX =
  'agora://ns/artifact/fix/sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// ---------------------------------------------------------------------------
// Run definition
// ---------------------------------------------------------------------------

/** Gate configuration on 'review': red → spawn-fix targeting 'implement'. */
const GATE_CONFIG: GateConfig = {
  onRed: 'spawn-fix',
  subject: 'implement',
  fixTemplate: { executor: 'dispatch', inputs: {} },
};

/**
 * Three-item run (no explicit depends_on — pipeline.plan chains them):
 *   implement → done + REF_IMPL
 *   review    → gate item; fails on first attempt (id = 'review'), passes on second (id = 'review~2')
 *   package   → done; needs.work from 'implement' (remapped to fix on respawn)
 *
 * pipeline.plan will chain: implement → review (depends_on: ['implement']),
 *                           package  → (depends_on: ['review']).
 * package's needs.work edge is explicit so respawn remaps it correctly.
 */
const RUN_ITEMS: WorkItem[] = [
  {
    id: 'implement',
    executor: 'dispatch',
    inputs: {},
    depends_on: [],
    resourceLocks: [],
  },
  {
    id: 'review',
    executor: 'dispatch',
    inputs: { gate: GATE_CONFIG },
    depends_on: [],
    resourceLocks: [],
  },
  {
    id: 'package',
    executor: 'dispatch',
    inputs: {},
    depends_on: [],
    resourceLocks: [],
    needs: {
      work: { from: 'implement', select: { kind: 'patch' } },
    },
  },
];

// ---------------------------------------------------------------------------
// Behavior map — deterministic, no state
// ---------------------------------------------------------------------------

/**
 * id-keyed behavior table.
 *
 * - 'review' (first attempt): failed — causes circle-back.
 * - 'review~2' (gate copy after fix): done — green gate.
 * - 'review-fix-1': done + REF_FIX (the fix item).
 * - Everything else (implement, package, package~2): done (implement gets REF_IMPL).
 */
function behavior(itemId: string) {
  if (itemId === 'review') {
    return { status: 'failed' as const };
  }
  if (itemId === 'implement') {
    return { status: 'done' as const, resultRef: REF_IMPL };
  }
  if (itemId === 'review-fix-1') {
    return { status: 'done' as const, resultRef: REF_FIX };
  }
  // review~2, package, package~2 → done
  return { status: 'done' as const };
}

// ---------------------------------------------------------------------------
// Scenario 1: Circle-back happy path
// ---------------------------------------------------------------------------

describe('pattern-dogfood: circle-back happy path', () => {
  it(
    'implement done, review failed/skipped, review-fix-1 done, review~2 done, package~2 done; ' +
      'run seals; run.extended audit entry with causeItemId=review; provenance closure intact',
    async () => {
      const blobs = new Map<string, Uint8Array>();
      const store = new SqliteRunStateStore();

      const executor = idKeyedExecutor(blobs, behavior);
      const { orch } = makeOrch(store, executor, {
        maxAttempts: 1,
        queues: { default: { concurrency: 5, pattern: pipeline } },
      });

      const runId = orch.submitRun(
        { id: 'dogfood-happy', queue: 'default', items: RUN_ITEMS },
        'human:test',
      );

      await driveUntilDone(orch, 64, runId);

      // ----- Status assertions -----
      const statuses = orch.getStatus(runId);
      const statusById = new Map(statuses.map((s) => [s.id, s.status]));

      expect(statusById.get('implement')).toBe('done');
      expect(statusById.get('review')).toBe('failed');
      // 'package' was chained after 'review' — it skips when review fails
      expect(statusById.get('package')).toBe('skipped');
      expect(statusById.get('review-fix-1')).toBe('done');
      expect(statusById.get('review~2')).toBe('done');
      expect(statusById.get('package~2')).toBe('done');

      // ----- Run sealed -----
      const exp = orch.getAuditExport(runId);
      expect(exp.root).toBeDefined();

      // ----- Exactly one 'run.extended' entry caused by 'review' -----
      const extendedEntries = exp.entries.filter((e) => e.kind === 'run.extended');
      expect(extendedEntries).toHaveLength(1);
      expect(extendedEntries[0]!.itemId).toBe('review');
      expect(extendedEntries[0]!.actor).toBe('pattern:default');

      // ----- Provenance: package~2's manifest seals inputRefs.work = REF_FIX -----
      const storage = storageFromBlobs(blobs);
      const anchor = new LocalAnchor(store);
      const bundle = await assembleBundle(exp, { anchor, storage });

      // Find the manifest whose inputRefs.work === REF_FIX
      const pkg2Manifest = bundle.manifests.find(
        (m) => m.inputRefs !== undefined && m.inputRefs['work'] === REF_FIX,
      );
      expect(pkg2Manifest).toBeDefined();

      // verifyBundle → intact=true, handoff=ok
      const report = await verifyBundle(bundle, { anchor });
      expect(report.intact).toBe(true);
      expect(report.checks.handoff.ok).toBe(true);

      store.close();
    },
  );
});

// ---------------------------------------------------------------------------
// Scenario 2: maxFixAttempts exhaustion
// ---------------------------------------------------------------------------

describe('pattern-dogfood: maxFixAttempts exhaustion', () => {
  it(
    'when review~2 also fails and maxFixAttempts=1, no review-fix-2 is spawned; run settles sealed',
    async () => {
      const blobs = new Map<string, Uint8Array>();
      const store = new SqliteRunStateStore();

      // Behavior variant: both 'review' and 'review~2' fail (exhausts default maxFixAttempts=1)
      function behaviorExhaust(itemId: string) {
        if (itemId === 'review' || itemId === 'review~2') {
          return { status: 'failed' as const };
        }
        if (itemId === 'implement') {
          return { status: 'done' as const, resultRef: REF_IMPL };
        }
        if (itemId === 'review-fix-1') {
          return { status: 'done' as const, resultRef: REF_FIX };
        }
        return { status: 'done' as const };
      }

      const executor = idKeyedExecutor(blobs, behaviorExhaust);
      const { orch } = makeOrch(store, executor, {
        maxAttempts: 1,
        queues: { default: { concurrency: 5, pattern: pipeline } },
      });

      const runId = orch.submitRun(
        { id: 'dogfood-exhaust', queue: 'default', items: RUN_ITEMS },
        'human:test',
      );

      await driveUntilDone(orch, 64, runId);

      const statuses = orch.getStatus(runId);
      const ids = statuses.map((s) => s.id);

      // 'review-fix-2' must NOT have been spawned (default maxFixAttempts = 1)
      expect(ids).not.toContain('review-fix-2');

      // Run must settle (all items terminal) and be sealed
      const exp = orch.getAuditExport(runId);
      expect(exp.root).toBeDefined();

      const allTerminal = statuses.every((s) =>
        ['done', 'failed', 'skipped', 'cancelled'].includes(s.status),
      );
      expect(allTerminal).toBe(true);

      store.close();
    },
  );
});

// ---------------------------------------------------------------------------
// Scenario 3: Cancelled run — no fix items ever spawned
// ---------------------------------------------------------------------------

describe('pattern-dogfood: cancelled run never resurrected', () => {
  it(
    'cancelRun before driving → all items cancelled/skipped → review-fix-1 never appears',
    async () => {
      const blobs = new Map<string, Uint8Array>();
      const store = new SqliteRunStateStore();

      const executor = idKeyedExecutor(blobs, behavior);
      const { orch } = makeOrch(store, executor, {
        maxAttempts: 1,
        queues: { default: { concurrency: 5, pattern: pipeline } },
      });

      const runId = orch.submitRun(
        { id: 'dogfood-cancel', queue: 'default', items: RUN_ITEMS },
        'human:test',
      );

      // Cancel before any tick — items are pending/ready, not yet dispatched
      orch.cancelRun(runId, 'human:test');

      // Now drive — the engine should not fire cancelled items
      await driveUntilDone(orch, 64, runId);

      const statuses = orch.getStatus(runId);
      const ids = statuses.map((s) => s.id);

      // 'review-fix-1' must never have been spawned
      expect(ids).not.toContain('review-fix-1');

      // All originally-submitted items must be in a terminal state
      for (const s of statuses) {
        expect(['cancelled', 'skipped', 'done', 'failed']).toContain(s.status);
      }

      store.close();
    },
  );
});
