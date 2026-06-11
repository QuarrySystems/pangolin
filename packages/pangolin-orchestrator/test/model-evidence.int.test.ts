// Model + cost evidence — end-to-end through the InprocWorkerExecutor fixture.
//
// Proves the full evidence story on one REAL in-proc run:
//   - requested model sealed in the dispatch manifest (authorization side),
//   - actual usage sealed in the output sentinel (capture side),
//   - AND the worker invocation actually receiving the model — the chain is
//     real (PANGOLIN_MODEL → cfg.model → BlockContext → RuntimeInvocation.model),
//     not faked at the manifest.
//
// Also proves the unpinned cell survives the whole chain: no def model + no
// defaultModel → manifest model.id '', invocation without a model, sentinel
// without usage when the adapter reports none (pin-optional posture).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageProvider } from '@quarry-systems/pangolin-storage-local';
import { PangolinClient, registerSubagent, registerPipeline } from '@quarry-systems/pangolin-client';
import type {
  PipelineSpec,
  RuntimeAdapter,
  RuntimeExit,
  RuntimeInvocation,
} from '@quarry-systems/pangolin-core';
import { buildPangolinUri, buildDispatchRecordUri } from '@quarry-systems/pangolin-core';
import { InprocWorkerExecutor } from './fixtures/inproc-worker-executor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalClient(storage: LocalStorageProvider, namespace: string): PangolinClient {
  return new PangolinClient({
    namespace,
    compute: {},
    credentials: {},
    storage,
    targets: {},
  });
}

/** A recording fake adapter: captures every invocation, returns a fixed exit. */
interface RecordingAdapter extends RuntimeAdapter {
  invocations: RuntimeInvocation[];
}

function adapterReturning(exit: RuntimeExit): RecordingAdapter {
  const invocations: RuntimeInvocation[] = [];
  return {
    name: 'fake-recording',
    reservedPaths: [],
    invocations,
    async invoke(spec: RuntimeInvocation): Promise<RuntimeExit> {
      invocations.push(spec);
      return exit;
    },
  };
}

/** Single agent block + outputs capture — the minimal pipeline that invokes the adapter. */
function agentPipeline(id: string): PipelineSpec {
  return {
    schemaVersion: 1,
    id,
    blocks: [
      { kind: 'agent' },
      { kind: 'capture', what: 'outputs' },
    ],
  };
}

/** dispatchHash is `inproc-<dispatchId>` — recover the dispatchId for sentinel reads. */
function dispatchIdOf(dispatchHash: string): string {
  if (!dispatchHash.startsWith('inproc-')) {
    throw new Error(`unexpected dispatchHash shape: ${dispatchHash}`);
  }
  return dispatchHash.slice('inproc-'.length);
}

async function readJson(storage: LocalStorageProvider, uri: string): Promise<Record<string, unknown>> {
  const bytes = await storage.get(uri);
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('model evidence end-to-end (InprocWorkerExecutor)', () => {
  let storageDir: string;
  let storage: LocalStorageProvider;
  const namespace = 'test-model-evidence';

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'model-evidence-'));
    storage = new LocalStorageProvider({ rootDir: storageDir });
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  /** Register a subagent (optionally pinning a model) + agent pipeline; build the WorkItem. */
  async function setupRun(opts: { subagentName: string; pipelineId: string; model?: string }) {
    const client = makeMinimalClient(storage, namespace);

    const subagentRef = await registerSubagent(client, {
      name: opts.subagentName,
      promptTemplate: 'unused',
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    });

    const pipelineSpec = agentPipeline(opts.pipelineId);
    const pipelineRef = await registerPipeline(client, pipelineSpec);

    const subagentPinnedUri = buildPangolinUri({
      namespace,
      type: 'subagent',
      name: subagentRef.name,
      contentHash: subagentRef.contentHash,
    });
    const pinnedPipelineUri = buildPangolinUri({
      namespace,
      type: 'pipeline',
      name: pipelineSpec.id,
      contentHash: pipelineRef.contentHash,
    });

    const workItem = {
      id: 'item-1',
      executor: 'dispatch',
      inputs: {
        subagent: subagentPinnedUri,
        pipeline: pinnedPipelineUri,
        workerInput: {},
        inputRefs: {},
      },
      depends_on: [],
      resourceLocks: [],
    };

    return { workItem };
  }

  it('seals requested model in the manifest and actual usage in the sentinel on a real in-proc run', async () => {
    const usage = { models: ['claude-sonnet-4-6'], costUsd: 0.02, turns: 2 };
    const fakeAdapter = adapterReturning({ exitCode: 0, stdout: 'done\n', stderr: '', usage });

    const { workItem } = await setupRun({
      subagentName: 'evidence-agent',
      pipelineId: 'test.evidence-agent',
      // No def model — the executor-mirrored resolution falls back to defaultModel.
    });

    const executor = new InprocWorkerExecutor({
      storage,
      namespace,
      adapter: fakeAdapter,
      defaultModel: 'standard',
    });

    const { dispatchHash, manifestRef } = await executor.fire(workItem, { runId: 'run-ev' });

    // Requested (authorization side): sealed into the dispatch manifest.
    expect(manifestRef).toBeDefined();
    const manifest = await readJson(storage, manifestRef as string);
    const executorManifest = manifest.executorManifest as { model?: { id: string; temperature: number; maxTokens: number } };
    expect(executorManifest.model).toEqual({ id: 'standard', temperature: 0, maxTokens: 0 });

    // The chain is REAL: the worker invocation actually received the model
    // (PANGOLIN_MODEL → cfg.model wins at the BlockContext build site).
    expect(fakeAdapter.invocations).toHaveLength(1);
    expect(fakeAdapter.invocations[0]!.model).toBe('standard');

    // Actual (capture side): sealed into the output sentinel after the run.
    const sentinel = await readJson(
      storage,
      buildDispatchRecordUri(namespace, dispatchIdOf(dispatchHash), 'output.json'),
    );
    expect(sentinel.usage).toEqual(usage);

    // And the run itself reconciles as done.
    const result = await executor.reconcile(dispatchHash);
    expect(result?.status).toBe('done');
  });

  it('def-pinned model wins over defaultModel, mirroring DispatchExecutor resolution', async () => {
    const fakeAdapter = adapterReturning({
      exitCode: 0,
      stdout: '',
      stderr: '',
      usage: { models: ['claude-opus-4-8'], costUsd: 0.4 },
    });

    const { workItem } = await setupRun({
      subagentName: 'evidence-agent-pinned',
      pipelineId: 'test.evidence-agent-pinned',
      model: 'def-model',
    });

    const executor = new InprocWorkerExecutor({
      storage,
      namespace,
      adapter: fakeAdapter,
      defaultModel: 'standard',
    });

    const { manifestRef } = await executor.fire(workItem, { runId: 'run-ev-pinned' });

    const manifest = await readJson(storage, manifestRef as string);
    const executorManifest = manifest.executorManifest as { model?: { id: string } };
    expect(executorManifest.model?.id).toBe('def-model');
    expect(fakeAdapter.invocations).toHaveLength(1);
    expect(fakeAdapter.invocations[0]!.model).toBe('def-model');
  });

  it('unpinned chain: manifest id empty, invocation without a model, sentinel without usage', async () => {
    // Adapter reports NO usage — the sentinel must carry no usage key at all.
    const fakeAdapter = adapterReturning({ exitCode: 0, stdout: '', stderr: '' });

    const { workItem } = await setupRun({
      subagentName: 'evidence-agent-unpinned',
      pipelineId: 'test.evidence-agent-unpinned',
      // No def model AND no defaultModel below.
    });

    const executor = new InprocWorkerExecutor({
      storage,
      namespace,
      adapter: fakeAdapter,
    });

    const { dispatchHash, manifestRef } = await executor.fire(workItem, { runId: 'run-ev-unpinned' });

    // Manifest: pin-optional — id is the empty string, never absent.
    const manifest = await readJson(storage, manifestRef as string);
    const executorManifest = manifest.executorManifest as { model?: { id: string; temperature: number; maxTokens: number } };
    expect(executorManifest.model).toEqual({ id: '', temperature: 0, maxTokens: 0 });

    // Invocation: NO model reached the worker invocation. registerSubagent
    // canonicalizes an absent model to `model: null` in the stored def, so the
    // worker's `cfg.model ?? subagent.model` yields null (not undefined) on the
    // real registration path — either way, nullish: no model was received.
    expect(fakeAdapter.invocations).toHaveLength(1);
    expect(fakeAdapter.invocations[0]!.model ?? undefined).toBeUndefined();

    // Sentinel: no usage key when the adapter reports none.
    const sentinel = await readJson(
      storage,
      buildDispatchRecordUri(namespace, dispatchIdOf(dispatchHash), 'output.json'),
    );
    expect('usage' in sentinel).toBe(false);

    const result = await executor.reconcile(dispatchHash);
    expect(result?.status).toBe('done');
  });
});
