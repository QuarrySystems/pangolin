import { describe, it, expect } from 'vitest';
import { AgoraOrchestrator } from '../src/orchestrator.js';
import { ManualTrigger } from '../src/triggers/manual.js';
import { SqliteRunStateStore } from '../src/runstate/sqlite.js';
import { AuditLog } from '../src/audit/audit-log.js';
import { NoneSigner } from '../src/audit/signer.js';
import { LocalAnchor } from '../src/audit/anchor.js';
import { buildManifest } from '../src/audit/manifest.js';
import { assembleBundle } from '../src/audit/bundle.js';
import { verifyBundle } from '../src/audit/verify-bundle.js';
import type { Executor, Run } from '../src/contracts/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** A's resultRef — the product that flows into B. Content-addressed opaque URI. */
const REF_A = 'agora://ns/artifact/a/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** A forged input ref that A never produced. */
const REF_FORGED = 'agora://ns/artifact/z/sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

// ---------------------------------------------------------------------------
// Executor factory
// ---------------------------------------------------------------------------

/**
 * Build a harness executor.
 *
 * - Item A has no needs; reconcile returns resultRef = REF_A.
 * - Item B has needs; its manifest seals whatever inputRefs the engine resolved (or
 *   the overridden forgeBInputRef when supplied).
 *
 * The executor stores manifest bytes in `blobs` (keyed by manifestRef) so
 * `assembleBundle` can retrieve them via the storage seam.
 */
function makeHandoffExecutor(blobs: Map<string, Uint8Array>, forgeBInputRef?: string): Executor {
  const firedItems = new Map<string, 'a' | 'b'>(); // dispatchHash -> which item

  return {
    id: 'dispatch',

    async fire(item, ctx) {
      // Determine if this is item B (the consumer): it has needs bindings
      // (the `needs` field is present on the WorkItem because submitRun preserves it)
      const rawRefs = item.inputs.inputRefs as Record<string, string> | undefined;
      const isB = item.needs !== undefined && Object.keys(item.needs).length > 0;

      // When forging, override the inputRefs B seals — simulating a tampered manifest.
      // The engine still passes the REAL resolved refs (rawRefs), but this executor
      // discards them and seals the forged ref instead.
      const inputRefs: Record<string, string> | undefined =
        forgeBInputRef && isB
          ? { patch: forgeBInputRef }
          : rawRefs;

      const { manifest, bytes } = buildManifest({
        runId: ctx?.runId ?? '',
        itemId: item.id,
        executor: 'dispatch',
        executorManifest: {},
        secretRefs: [],
        actor: ctx?.actor ?? 'human:test',
        firedAt: '2026-06-05T00:00:00.000Z',
        ...(inputRefs ? { inputRefs } : {}),
      });

      const manifestRef = `agora://ns/manifest/m/${manifest.manifestHash}`;
      blobs.set(manifestRef, bytes);

      const dispatchHash = `d-${item.id}`;
      firedItems.set(dispatchHash, isB ? 'b' : 'a');

      return { dispatchHash, manifestRef };
    },

    async reconcile(dispatchHash) {
      const which = firedItems.get(dispatchHash);
      if (!which) return null;
      if (which === 'a') {
        return { status: 'done' as const, resultRef: REF_A };
      }
      // B: done but no resultRef (it is a consumer, not a producer in this run)
      return { status: 'done' as const };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOrch(
  store: SqliteRunStateStore,
  executor: Executor,
) {
  const auditLog = new AuditLog({ store, signer: NoneSigner, anchor: new LocalAnchor(store) });
  const orch = new AgoraOrchestrator({
    store,
    executors: { dispatch: executor },
    triggers: { manual: new ManualTrigger() },
    queues: { default: { concurrency: 5 } },
    auditLog,
  });
  return { orch, auditLog };
}

/** Drive the orchestrator until all items reach a terminal status or tick-limit hit. */
async function driveUntilDone(
  orch: AgoraOrchestrator,
  maxTicks = 16,
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    await orch.tick('default');
    const statuses = orch.getStatus().map((s) => s.status);
    if (statuses.length > 0 && statuses.every((s) => ['done', 'failed', 'skipped', 'cancelled'].includes(s))) {
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Run definition — A produces REF_A; B consumes it via needs
// ---------------------------------------------------------------------------

/**
 * Run with two items:
 *   A: fires, reconciles with resultRef=REF_A
 *   B: needs A's patch product; engine resolves inputs.inputRefs = { patch: REF_A } at fire-time
 *
 * No explicit depends_on on B — submitRun auto-unions needs.*.from into depends_on (orchestrator.ts).
 */
const RUN: Run = {
  id: 'handoff-dag-test',
  queue: 'default',
  items: [
    {
      id: 'a',
      executor: 'dispatch',
      inputs: {},
      depends_on: [],
      resourceLocks: [],
    },
    {
      id: 'b',
      executor: 'dispatch',
      inputs: {},
      depends_on: [],
      resourceLocks: [],
      needs: {
        patch: { from: 'a', select: { kind: 'patch' } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handoff-dag integration (spec §8)', () => {
  it('a needs-wired run yields a bundle whose handoff check passes', async () => {
    const blobs = new Map<string, Uint8Array>();
    const store = new SqliteRunStateStore();

    const { orch } = makeOrch(store, makeHandoffExecutor(blobs));

    const runId = orch.submitRun({ ...RUN, id: 'handoff-dag-happy' }, 'human:test');
    await driveUntilDone(orch);

    // Confirm both items are done
    const statuses = orch.getStatus(runId);
    expect(statuses).toHaveLength(2);
    for (const s of statuses) {
      expect(s.status).toBe('done');
    }

    // Confirm run sealed (root present in export)
    const exp = orch.getAuditExport(runId);
    expect(exp.root).toBeDefined();

    // Assemble the bundle (real assembleBundle + storage + anchor)
    const anchor = new LocalAnchor(store);
    const storage = {
      get: async (ref: string) => {
        const b = blobs.get(ref);
        if (!b) throw new Error(`missing blob: ${ref}`);
        return b;
      },
    };

    const bundle = await assembleBundle(exp, { anchor, storage });

    // B's manifest must carry inputRefs { patch: REF_A }
    const bManifest = bundle.manifests.find(
      (m) => m.inputRefs !== undefined && m.inputRefs['patch'] !== undefined,
    );
    expect(bManifest).toBeDefined();
    expect(bManifest!.inputRefs).toEqual({ patch: REF_A });

    // Full verifyBundle pass
    const report = await verifyBundle(bundle, { anchor });
    expect(report.intact).toBe(true);
    expect(report.checks.handoff.ok).toBe(true);
    expect(report.checks.handoff.detail).toBe('1 input ref accounted for');

    store.close();
  });

  it('a forged input ref fails the handoff check while chain/root/anchor pass', async () => {
    const blobs = new Map<string, Uint8Array>();
    const store = new SqliteRunStateStore();

    // B's manifest seals REF_FORGED instead of the real REF_A resolved by the engine
    const { orch } = makeOrch(store, makeHandoffExecutor(blobs, REF_FORGED));

    const runId = orch.submitRun({ ...RUN, id: 'handoff-dag-tamper' }, 'human:test');
    await driveUntilDone(orch);

    // Run still completes (the engine doesn't check manifest content — that's verifyBundle's job)
    const statuses = orch.getStatus(runId);
    for (const s of statuses) {
      expect(s.status).toBe('done');
    }

    const exp = orch.getAuditExport(runId);
    expect(exp.root).toBeDefined();

    const anchor = new LocalAnchor(store);
    const storage = {
      get: async (ref: string) => {
        const b = blobs.get(ref);
        if (!b) throw new Error(`missing blob: ${ref}`);
        return b;
      },
    };

    const bundle = await assembleBundle(exp, { anchor, storage });
    const report = await verifyBundle(bundle, { anchor });

    // Handoff check must fail because REF_FORGED was never produced by A
    expect(report.checks.handoff.ok).toBe(false);
    expect(report.intact).toBe(false);
    expect(report.failure).toBe('handoff');

    // Chain, root, and anchor checks remain ok — the handoff signal is isolated
    expect(report.checks.chain.ok).toBe(true);
    expect(report.checks.root.ok).toBe(true);
    expect(report.checks.anchor.ok).toBe(true);

    store.close();
  });
});
