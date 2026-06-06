import { AgoraOrchestrator, type AgoraOrchestratorOptions } from '../../src/orchestrator.js';
import { ManualTrigger } from '../../src/triggers/manual.js';
import { SqliteRunStateStore } from '../../src/runstate/sqlite.js';
import { AuditLog } from '../../src/audit/audit-log.js';
import { NoneSigner } from '../../src/audit/signer.js';
import { LocalAnchor } from '../../src/audit/anchor.js';
import { buildManifest } from '../../src/audit/manifest.js';
import type { Executor } from '../../src/contracts/index.js';

export interface ItemBehavior {
  status: 'done' | 'failed';
  resultRef?: string;
  outputRefs?: Record<string, string>;
  verify?: { passed: boolean };
}

/**
 * Id-keyed deterministic fake executor.
 *
 * fire() seals the engine-resolved inputs.inputRefs into a manifest blob
 * (handoff-dag.int.test.ts pattern); reconcile() returns behavior(itemId).
 * Item ids arrive de-namespaced (the orchestrator wraps executors).
 *
 * **Instance reuse semantics:** each `idKeyedExecutor` instance maintains its own
 * internal `dispatchMap`. The dispatchHash now encodes the runId so that two runs
 * sharing a logical item id do NOT collide. However, a single instance IS safe to
 * reuse across runs precisely because of this encoding.
 *
 * @param blobs - Mutable map where manifest bytes are stored keyed by manifestRef.
 * @param behavior - Called with the de-namespaced item id; returns terminal outcome.
 */
export function idKeyedExecutor(
  blobs: Map<string, Uint8Array>,
  behavior: (itemId: string) => ItemBehavior,
): Executor {
  // Map from dispatchHash -> de-namespaced itemId
  const dispatchMap = new Map<string, string>();

  return {
    id: 'dispatch',

    async fire(item, ctx) {
      const inputRefs = item.inputs.inputRefs as Record<string, string> | undefined;

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

      // Include runId in the dispatchHash so that two runs sharing the same logical
      // item id cannot collide inside this instance's dispatchMap.
      const dispatchHash = `d-${ctx?.runId ?? ''}-${item.id}`;
      dispatchMap.set(dispatchHash, item.id);

      return { dispatchHash, manifestRef };
    },

    async reconcile(dispatchHash) {
      const itemId = dispatchMap.get(dispatchHash);
      if (itemId === undefined) return null;
      const b = behavior(itemId);
      return {
        status: b.status,
        ...(b.resultRef !== undefined ? { resultRef: b.resultRef } : {}),
        ...(b.outputRefs !== undefined ? { outputRefs: b.outputRefs } : {}),
        ...(b.verify !== undefined ? { verify: b.verify } : {}),
      };
    },
  };
}

/**
 * Orchestrator factory with audit wiring.
 *
 * `extra` is merged into the options so that callers can override individual
 * executors without replacing the whole executors map. `extra.executors` is
 * merged with the default `{ dispatch: executor }` — keys in `extra.executors`
 * take precedence. All other `extra` keys are spread last (highest precedence).
 */
export function makeOrch(
  store: SqliteRunStateStore,
  executor: Executor,
  extra?: Partial<AgoraOrchestratorOptions>,
): { orch: AgoraOrchestrator; anchor: LocalAnchor } {
  const anchor = new LocalAnchor(store);
  const auditLog = new AuditLog({ store, signer: NoneSigner, anchor });
  const { executors: extraExecutors, ...restExtra } = extra ?? {};
  const orch = new AgoraOrchestrator({
    store,
    executors: { dispatch: executor, ...extraExecutors },
    triggers: { manual: new ManualTrigger() },
    queues: { default: { concurrency: 5 } },
    auditLog,
    ...restExtra,
  });
  return { orch, anchor };
}

/**
 * Drive the orchestrator until all items (optionally scoped to `runId`) reach a
 * terminal status or the tick-limit is hit.
 *
 * @param runId - When provided, only items belonging to this run are checked.
 *   Defaults to checking all active runs (legacy behaviour).
 */
export async function driveUntilDone(orch: AgoraOrchestrator, maxTicks = 32, runId?: string): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    await orch.tick('default');
    const statuses = orch.getStatus(runId).map((s) => s.status);
    if (statuses.length > 0 && statuses.every((s) => ['done', 'failed', 'skipped', 'cancelled'].includes(s))) {
      return;
    }
  }
}

/** Drive the orchestrator until a predicate is true or tick-limit is hit. */
export async function driveUntil(orch: AgoraOrchestrator, pred: () => boolean, maxTicks = 32): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (pred()) return;
    await orch.tick('default');
  }
}

/**
 * Build a minimal storage adapter backed by a blob map.
 * Compatible with assembleBundle's storage seam.
 */
export function storageFromBlobs(blobs: Map<string, Uint8Array>): { get(ref: string): Promise<Uint8Array> } {
  return {
    async get(ref: string): Promise<Uint8Array> {
      const b = blobs.get(ref);
      if (!b) throw new Error(`missing blob: ${ref}`);
      return b;
    },
  };
}
