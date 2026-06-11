// TEST FIXTURE — InprocWorkerExecutor
//
// An Executor that runs pangolin-worker's runWorker() IN-PROCESS rather than in
// a real container. This bypasses container isolation BY DESIGN: it is a test
// fixture that wires the orchestrator engine against the real worker lifecycle
// (bundle-fetch, overlay, pipeline-runner, sentinel-write) without Docker.
//
// NOT safe for production use. By default the stub RuntimeAdapter throws on
// any agent block invocation — script-only and capture-only pipelines run to
// completion. Inject `adapter` to exercise agent blocks (model/usage evidence).
//
// Usage: provide a shared LocalStorageProvider and namespace; register bundles
// via the real client APIs (registerSubagent / registerPipeline) before firing.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Executor, ExecutionResult, FireContext, WorkItem } from '../../src/contracts/index.js';
import { buildManifest } from '../../src/audit/manifest.js';
import {
  buildPangolinUri,
  buildDispatchRecordUri,
  computeContentHash,
  parsePangolinUri,
} from '@quarry-systems/pangolin-core';
import type { StorageProvider, RuntimeAdapter } from '@quarry-systems/pangolin-core';
import { runWorker } from '@quarry-systems/pangolin-worker';

export interface InprocWorkerExecutorOptions {
  /** Shared LocalStorageProvider (or any StorageProvider) that bundles are registered to. */
  storage: StorageProvider;
  /** Pangolin Scale namespace matching the one used during registration. */
  namespace: string;
  /** Inject a RuntimeAdapter for agent blocks (default: reject as today). */
  adapter?: RuntimeAdapter;
  /** Authorization-side default, mirroring DispatchExecutor.defaultModel. */
  defaultModel?: string;
}

interface DispatchRecord {
  dispatchId: string;
  exitCode: number;
}

/**
 * Minimal stub RuntimeAdapter that throws if any agent block tries to invoke
 * it. Script/capture blocks never call adapter.invoke, so script-only
 * pipelines run cleanly.
 */
const stubAdapter: RuntimeAdapter = {
  name: 'inproc-stub',
  reservedPaths: [],
  async invoke() {
    throw new Error('inproc executor: agent block not supported');
  },
};

/**
 * Minimal no-op SecretStore for the worker injection seam. The inproc fixture
 * carries no per-dispatch secrets — all env is passed directly via env vars.
 */
const noopSecretStore = {
  name: 'noop',
  async stage(): Promise<never> {
    throw new Error('inproc executor: secret staging not supported');
  },
  async resolve(ref: string): Promise<string> {
    throw new Error(`inproc executor: secret resolve not supported (ref: ${ref})`);
  },
  async cleanupByTag(): Promise<void> {
    // no-op
  },
};

/**
 * Parse a pinned pangolin:// URI and return both the uri and contentHash.
 * Throws if the URI is not pinned (no contentHash).
 */
function parsePinnedUri(uri: string): { uri: string; contentHash: string } {
  const parts = parsePangolinUri(uri);
  if (!parts.contentHash) {
    throw new Error(`InprocWorkerExecutor: expected pinned URI (with contentHash), got: ${uri}`);
  }
  return { uri, contentHash: parts.contentHash };
}

/** Sanitize a string for use as a dispatchId (no `/` allowed). */
function sanitizeDispatchId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '-');
}

export class InprocWorkerExecutor implements Executor {
  readonly id = 'dispatch';

  private readonly storage: StorageProvider;
  private readonly namespace: string;
  private readonly adapter: RuntimeAdapter | undefined;
  private readonly defaultModel: string | undefined;
  private readonly records = new Map<string, DispatchRecord>();
  private attemptCounter = 0;

  constructor(opts: InprocWorkerExecutorOptions) {
    this.storage = opts.storage;
    this.namespace = opts.namespace;
    this.adapter = opts.adapter;
    this.defaultModel = opts.defaultModel;
  }

  async fire(
    item: WorkItem,
    ctx?: FireContext,
  ): Promise<{ dispatchHash: string; manifestRef?: string }> {
    this.attemptCounter += 1;
    const attemptNum = this.attemptCounter;

    // Build a unique dispatchId with no `/` characters.
    const rawDispatchId = `${ctx?.runId ?? 'run'}-${item.id}-${attemptNum}`;
    const dispatchId = sanitizeDispatchId(rawDispatchId);

    // Extract the subagent pinned URI from item.inputs.subagent.
    const subagentUri = item.inputs.subagent as string;
    const subagentRef = parsePinnedUri(subagentUri);

    // Extract the pipeline pinned URI from item.inputs.pipeline (required for script pipelines).
    const rawPipeline = item.inputs.pipeline;
    const pipelineUri = typeof rawPipeline === 'string' && rawPipeline.length > 0
      ? rawPipeline
      : undefined;
    const pipelineRef = pipelineUri !== undefined ? parsePinnedUri(pipelineUri) : undefined;

    // Build inputRefs for PANGOLIN_BUNDLE_REFS_JSON (if any).
    const rawInputRefs = item.inputs.inputRefs;
    const inputRefs: Array<{ key: string; uri: string; contentHash: string }> =
      rawInputRefs && typeof rawInputRefs === 'object'
        ? Object.entries(rawInputRefs as Record<string, unknown>)
            .filter(([, v]) => typeof v === 'string')
            .map(([key, v]) => {
              const r = parsePinnedUri(v as string);
              return { key, uri: r.uri, contentHash: r.contentHash };
            })
        : [];

    // Construct PANGOLIN_BUNDLE_REFS_JSON. The worker expects:
    //   { subagent: {uri, contentHash}, capabilities: [], env: [], inputs?: [...], pipeline?: {uri, contentHash} }
    const bundleRefs: Record<string, unknown> = {
      subagent: subagentRef,
      capabilities: [],
      env: [],
      ...(inputRefs.length > 0 ? { inputs: inputRefs } : {}),
      ...(pipelineRef !== undefined ? { pipeline: pipelineRef } : {}),
    };

    // Storage root URI — LocalStorageProvider exposes .rootUri.
    const storageUri = (this.storage as unknown as { rootUri?: string }).rootUri
      ?? 'file:///inproc-storage';

    // Pre-fire model resolution (authorization side) — mirrors DispatchExecutor:
    // def.model (empty string treated as unset) falls back to defaultModel.
    const requestedModel = await this.resolveRequestedModel(subagentRef.uri);

    // Construct the worker env. PANGOLIN_MODEL is emitted whenever the effective
    // requested model is set — WITHOUT this the manifest below would claim a
    // model the in-proc worker never received (the chain must be real).
    const workerEnv: Record<string, string> = {
      PANGOLIN_DISPATCH_ID: dispatchId,
      PANGOLIN_NAMESPACE: this.namespace,
      PANGOLIN_STORAGE_URI: storageUri,
      PANGOLIN_BUNDLE_REFS_JSON: JSON.stringify(bundleRefs),
      PANGOLIN_INPUT_JSON: JSON.stringify(
        (item.inputs.workerInput as Record<string, unknown> | undefined) ?? {},
      ),
      PANGOLIN_SECRET_STORE_KIND: 'aws-secrets-manager', // irrelevant — secretStore injected
      ...(requestedModel !== undefined ? { PANGOLIN_MODEL: requestedModel } : {}),
    };

    // Allocate a fresh workspace per fire.
    const workspaceDir = await mkdtemp(join(tmpdir(), 'inproc-workspace-'));

    const deps: Parameters<typeof runWorker>[1] = {
      storage: this.storage,
      adapter: this.adapter ?? stubAdapter,
      workspaceDir,
      secretStore: noopSecretStore,
    };

    // Run the worker in-process. exitCode is the terminal result.
    let exitCode: number;
    try {
      exitCode = await runWorker(workerEnv, deps);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    }

    // Record the dispatch result.
    const dispatchHash = `inproc-${dispatchId}`;
    this.records.set(dispatchHash, { dispatchId, exitCode });

    // Build and store a manifest (provenance closure — mirrors idKeyedExecutor in
    // pattern-harness.ts). Uses the engine-resolved inputRefs from item.inputs.
    let manifestRef: string | undefined;
    try {
      const inputRefsForManifest: Record<string, string> | undefined =
        rawInputRefs && typeof rawInputRefs === 'object' && Object.keys(rawInputRefs).length > 0
          ? (Object.fromEntries(
              Object.entries(rawInputRefs as Record<string, unknown>).filter(
                ([, v]) => typeof v === 'string',
              ),
            ) as Record<string, string>)
          : undefined;

      const { bytes } = buildManifest({
        runId: ctx?.runId ?? '',
        itemId: item.id,
        executor: this.id,
        // Requested-model evidence — same shape DispatchExecutor seals:
        // id is the effective requested string, '' when unpinned (pin-optional).
        executorManifest: {
          model: { id: requestedModel ?? '', temperature: 0, maxTokens: 0 },
        },
        secretRefs: [],
        actor: ctx?.actor ?? 'human:test',
        firedAt: new Date().toISOString(),
        ...(inputRefsForManifest ? { inputRefs: inputRefsForManifest } : {}),
        ...(pipelineUri !== undefined ? { pipelineRef: pipelineUri } : {}),
      });

      const contentHash = computeContentHash(bytes);
      manifestRef = buildPangolinUri({
        namespace: this.namespace,
        type: 'manifest',
        name: dispatchId,
        contentHash,
      });
      await this.storage.put(manifestRef, bytes);
    } catch {
      manifestRef = undefined; // best-effort; do NOT rethrow
    }

    return { dispatchHash, manifestRef };
  }

  async reconcile(dispatchHash: string): Promise<ExecutionResult | null> {
    const record = this.records.get(dispatchHash);
    if (record === undefined) return null;

    if (record.exitCode !== 0) {
      return { status: 'failed' };
    }

    // Read the sentinel from shared storage.
    try {
      const sentinelUri = buildDispatchRecordUri(this.namespace, record.dispatchId, 'output.json');
      const bytes = await this.storage.get(sentinelUri);
      const sentinel = JSON.parse(new TextDecoder().decode(bytes)) as {
        patchRef?: string;
        verify?: { passed: boolean; report?: string; durationMs?: number };
        outputs?: Array<{ path: string; ref: string }>;
      };

      const result: ExecutionResult = { status: 'done' };

      if (typeof sentinel.patchRef === 'string') {
        result.resultRef = sentinel.patchRef;
      }

      const v = sentinel.verify;
      if (v && typeof v.passed === 'boolean') {
        result.verify = { passed: v.passed };
        if (typeof v.report === 'string') result.verify.report = v.report.slice(0, 16_000);
        if (typeof v.durationMs === 'number' && Number.isFinite(v.durationMs)) {
          result.verify.durationMs = v.durationMs;
        }
      }

      const MAX_SENTINEL_OUTPUTS = 256;
      if (Array.isArray(sentinel.outputs)) {
        const outputRefs = Object.create(null) as Record<string, string>;
        for (const e of sentinel.outputs.slice(0, MAX_SENTINEL_OUTPUTS)) {
          if (e && typeof e.path === 'string' && typeof e.ref === 'string') {
            outputRefs[e.path] = e.ref;
          }
        }
        if (Object.keys(outputRefs).length > 0) {
          result.outputRefs = outputRefs;
        }
      }

      return result;
    } catch {
      // Sentinel missing or malformed — treat as done with no outputs.
      return { status: 'done' };
    }
  }

  /**
   * Best-effort pre-fire model resolution mirroring DispatchExecutor's
   * resolveRequestedModel: read the subagent def from the PINNED uri carried
   * in item.inputs.subagent and return `def.model ?? defaultModel`, with an
   * empty-string def model treated as unset. NEVER throws — any failure
   * returns the defaultModel, which may be undefined.
   * The fixture always receives a pinned URI from `setupRun`, so `resolveLatest` is not needed; production `DispatchExecutor` resolves the mutable name first.
   */
  private async resolveRequestedModel(pinnedSubagentUri: string): Promise<string | undefined> {
    try {
      const bytes = await this.storage.get(pinnedSubagentUri);
      const def = JSON.parse(new TextDecoder().decode(bytes)) as { model?: unknown };
      return typeof def.model === 'string' && def.model.length > 0
        ? def.model
        : this.defaultModel;
    } catch {
      return this.defaultModel;
    }
  }
}
