import type { AgoraClient, InFlightDispatch } from '@quarry-systems/agora-client';
import type { DispatchWork } from '@quarry-systems/agora-core';
import { buildAgoraUri, buildDispatchRecordUri, computeContentHash } from '@quarry-systems/agora-core';
import type { Executor, ExecutionResult, FireContext, WorkItem } from '../contracts/index.js';
import { buildManifest } from '../audit/manifest.js';
import type { DispatchExecutorManifest } from '../contracts/manifest.js';

export interface DispatchExecutorOptions {
  /** A fully-wired AgoraClient (namespace, compute, credentials, storage). */
  client: AgoraClient;
  /** Deploy-time: which AgoraClient target to dispatch against (NOT from WorkItem inputs). */
  target: string;
  /** Deploy-time: digest-pinned worker image (NOT from WorkItem inputs). */
  workerImage: string;
  /**
   * Deploy-time secrets attached to EVERY dispatch — staged via the client's
   * secret path (LocalSecretStore for file:// storage, AWS otherwise) and
   * log-redacted by the worker. Configured here (privileged, e.g. from
   * `process.env` in agora.config.mjs), NEVER carried in a WorkItem's inputs:
   * a run-time/MCP-submitted item must not supply or read secret values (§10.6).
   */
  secrets?: DispatchWork['secrets'];
}

type Settled =
  | { kind: 'exit'; exit: Awaited<ReturnType<InFlightDispatch['awaitExit']>> }
  | { kind: 'error'; error: unknown };

interface InFlightEntry {
  inflight: InFlightDispatch;
  settled: Settled | null;
}

/** First concrete Executor: runs WorkItems as agora container dispatches (spec §2). */
export class DispatchExecutor implements Executor {
  readonly id = 'dispatch';
  private readonly inflight = new Map<string, InFlightEntry>();

  constructor(private readonly opts: DispatchExecutorOptions) {}

  async fire(item: WorkItem, ctx?: FireContext): Promise<{ dispatchHash: string; manifestRef?: string }> {
    const subagent = item.inputs.subagent;
    if (typeof subagent !== 'string' || subagent.length === 0) {
      throw new Error(`DispatchExecutor: WorkItem '${item.id}' is missing a string inputs.subagent`);
    }
    // Container starts HERE. Anything that throws BEFORE this is a clean pre-start
    // failure. Anything AFTER must NOT throw, or tick fails the item without
    // recording the dispatchHash and the running container is orphaned.
    const flight = await this.opts.client.dispatch.fire({
      subagent,
      env: item.inputs.env as string | string[] | undefined,
      input: (item.inputs.workerInput as Record<string, unknown> | undefined) ?? {},
      target: this.opts.target,
      workerImage: this.opts.workerImage,
      secrets: this.opts.secrets,
    });
    const entry: InFlightEntry = { inflight: flight, settled: null };
    // Detached background await — never throws out; records terminal state for reconcile().
    void flight.awaitExit().then(
      (exit) => { entry.settled = { kind: 'exit', exit }; },
      (error) => { entry.settled = { kind: 'error', error }; },
    );
    this.inflight.set(flight.dispatchId, entry);

    let manifestRef: string | undefined;
    try {
      const r = flight.resolved; // { subagent, capabilities, env, secretRefs, workerImage }
      const model = await this.resolveModel(r.subagent);
      const executorManifest: DispatchExecutorManifest = {
        subagent: { name: r.subagent.name, contentHash: r.subagent.contentHash },
        capabilities: r.capabilities.map((c) => ({ name: c.name, contentHash: c.contentHash })),
        env: r.env.map((e) => ({ name: e.name, contentHash: e.contentHash })),
        workerImage: r.workerImage,
        model,
      };
      const { bytes } = buildManifest({
        runId: ctx?.runId ?? '',
        itemId: item.id,
        executor: this.id,
        executorManifest,
        secretRefs: Object.values(r.secretRefs),
        actor: ctx?.actor ?? '',
        firedAt: new Date().toISOString(),
        submittedAt: ctx?.submittedAt,
      });
      // Content-address: compute hash FIRST, build pinned URI, put to it (mirrors
      // subagent-register.ts — round-trips on real LocalStorageProvider AND on the
      // in-memory test stub which stores by exact URI).
      const ns = this.opts.client.namespace;
      const contentHash = computeContentHash(bytes);
      manifestRef = buildAgoraUri({ namespace: ns, type: 'manifest', name: flight.dispatchId, contentHash });
      await this.opts.client.storage.put(manifestRef, bytes);
    } catch {
      manifestRef = undefined; // best-effort; do NOT rethrow (container already running)
    }

    return { dispatchHash: flight.dispatchId, manifestRef };
  }

  async reconcile(dispatchHash: string): Promise<ExecutionResult | null> {
    const entry = this.inflight.get(dispatchHash);
    if (!entry || entry.settled === null) return null; // unknown or still running
    this.inflight.delete(dispatchHash);
    if (entry.settled.kind === 'error') {
      entry.inflight.cleanup();
      return { status: 'failed', output: { error: String(entry.settled.error) } };
    }
    const result = await entry.inflight.reconcile(entry.settled.exit);
    entry.inflight.cleanup();
    const status = result.exitCode === 0 ? 'done' : 'failed';
    if (status === 'done') {
      const { patchRef, verify } = await this.readSentinel(dispatchHash);
      return { status, output: result, resultRef: patchRef, verify };
    }
    return { status, output: result };
  }

  /**
   * Best-effort: read the patchRef and verify signal from the dispatch output
   * sentinel. NEVER throws — any failure returns an empty object.
   */
  private async readSentinel(
    dispatchId: string,
  ): Promise<{ patchRef?: string; verify?: ExecutionResult['verify'] }> {
    try {
      const ns = this.opts.client.namespace;
      const bytes = await this.opts.client.storage.get(
        buildDispatchRecordUri(ns, dispatchId, 'output.json'),
      );
      const sentinel = JSON.parse(new TextDecoder().decode(bytes));
      const out: { patchRef?: string; verify?: ExecutionResult['verify'] } = {};
      if (typeof sentinel.patchRef === 'string') out.patchRef = sentinel.patchRef;
      // Construct a clean, bounded verify from the (worker-written but possibly
      // older/tampered) sentinel — don't forward the raw object by reference.
      const v = sentinel.verify;
      if (v && typeof v.passed === 'boolean') {
        const verify: NonNullable<ExecutionResult['verify']> = { passed: v.passed };
        if (typeof v.report === 'string') verify.report = v.report.slice(0, 16_000);
        if (typeof v.durationMs === 'number' && Number.isFinite(v.durationMs)) {
          verify.durationMs = v.durationMs;
        }
        out.verify = verify;
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * Best-effort: fetch the subagent blob and extract the model field.
   * NEVER throws — any failure returns the zero-value model.
   */
  private async resolveModel(
    subagentRef: { name: string; contentHash: string },
  ): Promise<{ id: string; temperature: number; maxTokens: number }> {
    const zero = { id: '', temperature: 0, maxTokens: 0 };
    try {
      const ns = this.opts.client.namespace;
      const uri = buildAgoraUri({
        namespace: ns,
        type: 'subagent',
        name: subagentRef.name,
        contentHash: subagentRef.contentHash,
      });
      const bytes = await this.opts.client.storage.get(uri);
      const def = JSON.parse(new TextDecoder().decode(bytes)) as { model?: unknown };
      return { id: typeof def.model === 'string' ? def.model : '', temperature: 0, maxTokens: 0 };
    } catch {
      return zero;
    }
  }
}
