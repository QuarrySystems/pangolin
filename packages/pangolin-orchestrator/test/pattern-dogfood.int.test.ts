// packages/pangolin-orchestrator/test/pattern-dogfood.int.test.ts
//
// End-to-end offline proof of the gated circle-back (spec §9): implement → review(gate) → package
// on the pipeline pattern, with deterministic red/green keyed by item id.
//
// Primary scenario (Scenario 1): gate is done-but-red (verify.passed===false).
//   The §7 engine predicate treats it as failed-like: dependents are skipped; the pattern
//   phase spawns [fix, gate~2, package~2]. The fix item's needs.work binding resolves via
//   implement (done, not a red gate), so it fires and completes. gate~2 fires and passes.
//   package~2 fires with needs.work === fix.resultRef (remap correct).
//
// §7 data-edge exemption (commit 9fb0ea7): when the gate is done-but-red AND the fix item
//   has a needs binding with from === gate.id AND select.kind === 'output', that dep is exempt
//   from the blocking-red predicate. The fix fires normally, its manifest inputRefs carries
//   BOTH work (=== implement.resultRef) AND findings (=== gate.outputRefs.findings) via the
//   normal auto-bind + resolve-at-fire path. This test exercises that full path.

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
  'pangolin://ns/artifact/impl/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** The product that 'review-fix-1' produces (the fixed patch artifact). */
const REF_FIX =
  'pangolin://ns/artifact/fix/sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** The findings artifact produced by the red gate 'review' in its outputRefs. */
const REF_FINDINGS =
  'pangolin://ns/artifact/findings/sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

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
 *   review    → gate item; done-but-red on first attempt (id = 'review'), passes on second (id = 'review~2')
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
 * id-keyed behavior table (done-but-red primary scenario).
 *
 * - 'review' (first attempt): done-but-red (verify.passed===false, outputRefs.findings===REF_FINDINGS).
 *   The §7 data-edge exemption allows the fix to fire despite the gate being done-but-red.
 * - 'review~2' (gate copy after fix): done — green gate.
 * - 'review-fix-1': done + REF_FIX (the fix item).
 * - Everything else (implement, package, package~2): done (implement gets REF_IMPL).
 */
function behavior(itemId: string) {
  if (itemId === 'review') {
    return { status: 'done' as const, verify: { passed: false }, outputRefs: { findings: REF_FINDINGS } };
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
// Scenario 1: done-but-red gate — full circle-back
// ---------------------------------------------------------------------------

describe('pattern-dogfood: circle-back happy path', () => {
  it(
    'done-but-red gate: full circle-back with findings-by-provenance and downstream remap',
    async () => {
      // Behavior: review (attempt 1) → { status:'done', verify:{passed:false}, outputRefs:{findings:REF_FINDINGS} }
      // Expected arc: implement done; review done (red); package SKIPPED; review-fix-1 done; review~2 done (green); package~2 done
      // Fix manifest inputRefs.work === REF_IMPL (subject.resultRef)
      // Fix manifest inputRefs.findings === REF_FINDINGS (gate's findings outputRef, via §7 data-edge exemption)
      // package~2 manifest inputRefs.work === REF_FIX (review-fix-1.resultRef)
      // verifyBundle: intact=true, handoff.ok=true over the grown graph (findings edge is a done item's outputRef)

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
      // 'review' is done-but-red (verify.passed === false) — status is 'done' not 'failed'
      expect(statusById.get('review')).toBe('done');
      // 'package' was chained after 'review' — it skips when gate is done-but-red (§7 cascade)
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

      // ----- Provenance: fix manifest inputRefs.work === REF_IMPL (subject.resultRef) -----
      const storage = storageFromBlobs(blobs);
      const anchor = new LocalAnchor(store);
      const bundle = await assembleBundle(exp, { anchor, storage });

      // Fix manifest: inputRefs.work === REF_IMPL (implement's resultRef, the subject's patch product)
      // Fix manifest: inputRefs.findings === REF_FINDINGS (gate's outputRefs.findings, via §7 data-edge exemption)
      const fixManifest = bundle.manifests.find((m) => m.itemId === 'review-fix-1');
      expect(fixManifest).toBeDefined();
      expect(fixManifest!.inputRefs?.['work']).toBe(REF_IMPL);
      expect(fixManifest!.inputRefs?.['findings']).toBe(REF_FINDINGS);

      // package~2 manifest: inputRefs.work === REF_FIX (remapped from fix item via review-fix-1 resultRef)
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

  it('run.extended entry carries itemId=<gate id> and actor=pattern:default', async () => {
    // From the assembled bundle's auditLog.entries: kind==='run.extended', itemId==='review', actor==='pattern:default'
    const blobs = new Map<string, Uint8Array>();
    const store = new SqliteRunStateStore();

    const executor = idKeyedExecutor(blobs, behavior);
    const { orch } = makeOrch(store, executor, {
      maxAttempts: 1,
      queues: { default: { concurrency: 5, pattern: pipeline } },
    });

    const runId = orch.submitRun(
      { id: 'dogfood-ext-entry', queue: 'default', items: RUN_ITEMS },
      'human:test',
    );

    await driveUntilDone(orch, 64, runId);

    const storage = storageFromBlobs(blobs);
    const anchor = new LocalAnchor(store);
    const exp = orch.getAuditExport(runId);
    const bundle = await assembleBundle(exp, { anchor, storage });

    const extendedEntries = bundle.auditLog.entries.filter((e) => e.kind === 'run.extended');
    expect(extendedEntries).toHaveLength(1);
    expect(extendedEntries[0]!.itemId).toBe('review');
    expect(extendedEntries[0]!.actor).toBe('pattern:default');

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: failed gate — retains the failed-gate path (still legal engine behavior)
// ---------------------------------------------------------------------------
// NOTE: This scenario keeps the 'failed' gate path exercised at the orchestrator level.
// The gateReason-degradation specifics (no outputRefs on a failed gate; fix receives
// inputs.gateReason as plain data instead of a needs.findings provenance edge) are
// pinned by unit assertions in respawn.test.ts — this scenario asserts the lifecycle
// outcome (no second fix beyond maxFixAttempts; run settles sealed).

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
