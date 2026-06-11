import type { PangolinClient, InFlightDispatch } from '@quarry-systems/pangolin-client';
import type { DispatchWork } from '@quarry-systems/pangolin-core';
import { buildPangolinUri, buildDispatchRecordUri, computeContentHash } from '@quarry-systems/pangolin-core';
import type { Executor, ExecutionResult, FireContext, WorkItem } from '../contracts/index.js';
import { buildManifest } from '../audit/manifest.js';
import type { DispatchExecutorManifest } from '../contracts/manifest.js';

export interface DispatchExecutorOptions {
  /** A fully-wired PangolinClient (namespace, compute, credentials, storage). */
  client: PangolinClient;
  /** Deploy-time: which PangolinClient target to dispatch against (NOT from WorkItem inputs). */
  target: string;
  /** Deploy-time: digest-pinned worker image (NOT from WorkItem inputs). */
  workerImage: string;
  /**
   * Deploy-time secrets attached to EVERY dispatch — staged via the client's
   * secret path (LocalSecretStore for file:// storage, AWS otherwise) and
   * log-redacted by the worker. Configured here (privileged, e.g. from
   * `process.env` in pangolin.config.mjs), NEVER carried in a WorkItem's inputs:
   * a run-time/MCP-submitted item must not supply or read secret values (§10.6).
   */
  secrets?: DispatchWork['secrets'];
  /** Authorization-side default when the subagent def pins no model (spec D3/D6). */
  defaultModel?: string;
}

type Settled =
  | { kind: 'exit'; exit: Awaited<ReturnType<InFlightDispatch['awaitExit']>> }
  | { kind: 'error'; error: unknown };

interface InFlightEntry {
  inflight: InFlightDispatch;
  settled: Settled | null;
}

/** First concrete Executor: runs WorkItems as Pangolin Scale container dispatches (spec §2). */
export class DispatchExecutor implements Executor {
  readonly id = 'dispatch';
  private readonly inflight = new Map<string, InFlightEntry>();

  constructor(private readonly opts: DispatchExecutorOptions) {}

  async fire(item: WorkItem, ctx?: FireContext): Promise<{ dispatchHash: string; manifestRef?: string }> {
    const subagent = item.inputs.subagent;
    if (typeof subagent !== 'string' || subagent.length === 0) {
      throw new Error(`DispatchExecutor: WorkItem '${item.id}' is missing a string inputs.subagent`);
    }
    // Read the inputRefs carrier set by tick's resolve-at-fire.
    // Shape guard (not trust guard): filter out any non-string values.
    const rawRefs = item.inputs.inputRefs;
    const inputRefs =
      rawRefs && typeof rawRefs === 'object'
        ? (Object.fromEntries(
            Object.entries(rawRefs as Record<string, unknown>).filter(
              ([, v]) => typeof v === 'string',
            ),
          ) as Record<string, string>)
        : undefined;

    // Read the optional pipeline carrier. Shape guard: must be a non-empty string.
    // Non-string or empty-string values are IGNORED (not thrown) — matching the
    // inputRefs posture.
    const rawPipeline = item.inputs.pipeline;
    const pipelineRef =
      typeof rawPipeline === 'string' && rawPipeline.length > 0 ? rawPipeline : undefined;

    // Pre-fire model resolution (authorization side): resolve the subagent's
    // latest def blob and read its pinned model; fall back to the executor's
    // configured defaultModel. Best-effort — any failure here yields just the
    // defaultModel (possibly undefined) and the fire proceeds.
    //
    // Race caveat: this resolveLatest can race a concurrent re-registration
    // relative to the client's OWN resolve inside dispatch.fire below. The
    // guaranteed invariant is manifest ≡ dispatched work — both carry the
    // model from THIS single pre-fire resolution. Manifest-vs-worker-blob
    // equality is the deferred verify row's business.
    const requestedModel = await this.resolveRequestedModel(subagent);

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
      ...(requestedModel !== undefined ? { model: requestedModel } : {}),
      ...(inputRefs && Object.keys(inputRefs).length ? { inputRefs } : {}),
      ...(pipelineRef !== undefined ? { pipelineRef } : {}),
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
      // Manifest model is the SAME value sealed into the dispatched work above
      // (single pre-fire resolution) — no post-fire re-fetch.
      const executorManifest: DispatchExecutorManifest = {
        subagent: { name: r.subagent.name, contentHash: r.subagent.contentHash },
        capabilities: r.capabilities.map((c) => ({ name: c.name, contentHash: c.contentHash })),
        env: r.env.map((e) => ({ name: e.name, contentHash: e.contentHash })),
        workerImage: r.workerImage,
        model: { id: requestedModel ?? '', temperature: 0, maxTokens: 0 },
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
        ...(inputRefs && Object.keys(inputRefs).length ? { inputRefs } : {}),
        ...(r.pipelineRef !== undefined ? { pipelineRef: r.pipelineRef } : {}),
      });
      // Content-address: compute hash FIRST, build pinned URI, put to it (mirrors
      // subagent-register.ts — round-trips on real LocalStorageProvider AND on the
      // in-memory test stub which stores by exact URI).
      const ns = this.opts.client.namespace;
      const contentHash = computeContentHash(bytes);
      manifestRef = buildPangolinUri({ namespace: ns, type: 'manifest', name: flight.dispatchId, contentHash });
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
      const { patchRef, verify, outputRefs } = await this.readSentinel(dispatchHash);
      return { status, output: result, resultRef: patchRef, verify, outputRefs };
    }
    return { status, output: result };
  }

  /**
   * Best-effort: read the patchRef, verify signal, and outputs from the dispatch
   * output sentinel. NEVER throws — any failure returns an empty object.
   */
  private async readSentinel(
    dispatchId: string,
  ): Promise<{ patchRef?: string; verify?: ExecutionResult['verify']; outputRefs?: ExecutionResult['outputRefs'] }> {
    try {
      const ns = this.opts.client.namespace;
      const bytes = await this.opts.client.storage.get(
        buildDispatchRecordUri(ns, dispatchId, 'output.json'),
      );
      const sentinel = JSON.parse(new TextDecoder().decode(bytes));
      const out: { patchRef?: string; verify?: ExecutionResult['verify']; outputRefs?: ExecutionResult['outputRefs'] } = {};
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
      // Construct a clean, bounded outputRefs from the sentinel outputs array.
      // Sentinel is worker-written and untrusted; reconstruct defensively.
      const MAX_SENTINEL_OUTPUTS = 256;
      const o = sentinel.outputs;
      if (Array.isArray(o)) {
        const outputRefs = Object.create(null) as Record<string, string>;
        for (const e of o.slice(0, MAX_SENTINEL_OUTPUTS)) {
          if (e && typeof e.path === 'string' && typeof e.ref === 'string') {
            outputRefs[e.path] = e.ref;
          }
        }
        if (Object.keys(outputRefs).length > 0) out.outputRefs = outputRefs;
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * Best-effort pre-fire model resolution: resolveLatest the subagent's def
   * blob and read `def.model`, falling back to the configured defaultModel.
   * NEVER throws — any failure (unresolvable name, unreadable blob, bad
   * JSON) returns the defaultModel, which may be undefined.
   */
  private async resolveRequestedModel(subagentName: string): Promise<string | undefined> {
    try {
      const ns = this.opts.client.namespace;
      const baseUri = buildPangolinUri({ namespace: ns, type: 'subagent', name: subagentName });
      const latest = await this.opts.client.storage.resolveLatest(baseUri);
      if (!latest) return this.opts.defaultModel;
      const bytes = await this.opts.client.storage.get(latest.uri);
      const def = JSON.parse(new TextDecoder().decode(bytes)) as { model?: unknown };
      return typeof def.model === 'string' && def.model.length > 0
        ? def.model
        : this.opts.defaultModel;
    } catch {
      return this.opts.defaultModel;
    }
  }
}
