// Test suite for the InprocWorkerExecutor fixture.
//
// Exercises fire→reconcile round-trips against REAL runWorker executions
// backed by LocalStorageProvider + REAL client registration APIs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageProvider } from '@quarry-systems/pangolin-storage-local';
import { PangolinClient } from '@quarry-systems/pangolin-client';
import { registerSubagent } from '@quarry-systems/pangolin-client';
import { registerPipeline } from '@quarry-systems/pangolin-client';
import type { PipelineSpec } from '@quarry-systems/pangolin-core';
import { buildPangolinUri } from '@quarry-systems/pangolin-core';
import { InprocWorkerExecutor } from './inproc-worker-executor.js';

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

// A script-only pipeline that writes a file to outputs/ so outputRefs round-trips.
// On Windows, `echo` is a cmd builtin; `mkdir` is available; the path separator
// in the command is important.
function makeScriptPipeline(outputContent: string): PipelineSpec {
  // Use node -e to avoid cross-platform shell compat issues
  const writeCmd = [
    'node',
    '-e',
    `"const fs=require('fs');fs.mkdirSync('outputs',{recursive:true});fs.writeFileSync('outputs/out.txt','${outputContent}');"`,
  ].join(' ');
  return {
    schemaVersion: 1,
    id: 'test.script-output',
    blocks: [
      { kind: 'script', command: writeCmd, timeoutSeconds: 30 },
      { kind: 'capture', what: 'outputs' },
    ],
  };
}

// A pipeline that contains an agent block — the inproc executor's stub adapter
// should throw, causing runWorker to return non-zero.
function makeAgentPipeline(): PipelineSpec {
  return {
    schemaVersion: 1,
    id: 'test.agent-block',
    blocks: [
      { kind: 'agent' },
      { kind: 'capture', what: 'outputs' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('InprocWorkerExecutor', () => {
  let storageDir: string;
  let storage: LocalStorageProvider;
  const namespace = 'test-inproc';

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'inproc-storage-'));
    storage = new LocalStorageProvider({ rootDir: storageDir });
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  it('fire→reconcile round-trips a script pipeline: outputRefs pinned and retrievable', async () => {
    const client = makeMinimalClient(storage, namespace);

    // Register subagent via REAL client API (required even for script-only pipelines
    // because the worker bundle-fetcher always fetches the subagent bundle).
    const subagentRef = await registerSubagent(client, {
      name: 'test-agent',
      promptTemplate: 'unused',
    });

    // Register a script-only pipeline via REAL client API.
    const pipelineSpec = makeScriptPipeline('hello-inproc');
    const pipelineRef = await registerPipeline(client, pipelineSpec);

    // Build the pinned pipeline URI (the format dispatch.ts uses).
    const pinnedPipelineUri = buildPangolinUri({
      namespace,
      type: 'pipeline',
      name: pipelineSpec.id,
      contentHash: pipelineRef.contentHash,
    });

    const executor = new InprocWorkerExecutor({ storage, namespace });

    // Build a WorkItem mimicking how the engine fires it (inputs.pipeline + inputs.subagent
    // are the engine-resolved pinned URIs).
    const subagentPinnedUri = buildPangolinUri({
      namespace,
      type: 'subagent',
      name: subagentRef.name,
      contentHash: subagentRef.contentHash,
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

    const ctx = { runId: 'run-1' };

    // TDD: fire should complete without throwing.
    const { dispatchHash, manifestRef } = await executor.fire(workItem, ctx);
    expect(typeof dispatchHash).toBe('string');
    expect(dispatchHash.length).toBeGreaterThan(0);
    expect(manifestRef).toBeDefined();

    // TDD: reconcile should return done with outputRefs.
    const result = await executor.reconcile(dispatchHash);
    expect(result).not.toBeNull();
    expect(result?.status).toBe('done');
    expect(result?.outputRefs).toBeDefined();
    expect(typeof result?.outputRefs?.['out.txt']).toBe('string');

    // TDD: the output ref must be retrievable from storage.
    const outRef = result?.outputRefs?.['out.txt'];
    expect(typeof outRef).toBe('string');
    const bytes = await storage.get(outRef as string);
    const content = new TextDecoder().decode(bytes);
    expect(content).toBe('hello-inproc');
  });

  it('reconcile returns null for an unknown dispatchHash', async () => {
    const executor = new InprocWorkerExecutor({ storage, namespace });
    const result = await executor.reconcile('unknown-hash-xyz');
    expect(result).toBeNull();
  });

  it('agent-block pipeline fails loudly: stub adapter throws, reconcile returns failed', async () => {
    const client = makeMinimalClient(storage, namespace);

    // Register subagent.
    const subagentRef = await registerSubagent(client, {
      name: 'test-agent-2',
      promptTemplate: 'unused',
    });

    // Register an agent pipeline.
    const pipelineSpec = makeAgentPipeline();
    const pipelineRef = await registerPipeline(client, pipelineSpec);

    const pinnedPipelineUri = buildPangolinUri({
      namespace,
      type: 'pipeline',
      name: pipelineSpec.id,
      contentHash: pipelineRef.contentHash,
    });

    const subagentPinnedUri = buildPangolinUri({
      namespace,
      type: 'subagent',
      name: subagentRef.name,
      contentHash: subagentRef.contentHash,
    });

    const executor = new InprocWorkerExecutor({ storage, namespace });

    const workItem = {
      id: 'item-agent',
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

    // fire should complete (worker exits non-zero, but fire doesn't throw).
    const { dispatchHash } = await executor.fire(workItem, { runId: 'run-2' });

    // reconcile should report failed.
    const result = await executor.reconcile(dispatchHash);
    expect(result).not.toBeNull();
    expect(result?.status).toBe('failed');
  });

  it('bundles are seeded via real registration (provenance: manifestRef is retrievable)', async () => {
    const client = makeMinimalClient(storage, namespace);

    const subagentRef = await registerSubagent(client, {
      name: 'test-agent-prov',
      promptTemplate: 'unused',
    });

    const pipelineSpec = makeScriptPipeline('provenance-check');
    const pipelineRef = await registerPipeline(client, pipelineSpec);

    const pinnedPipelineUri = buildPangolinUri({
      namespace,
      type: 'pipeline',
      name: pipelineSpec.id,
      contentHash: pipelineRef.contentHash,
    });

    const subagentPinnedUri = buildPangolinUri({
      namespace,
      type: 'subagent',
      name: subagentRef.name,
      contentHash: subagentRef.contentHash,
    });

    const executor = new InprocWorkerExecutor({ storage, namespace });

    const workItem = {
      id: 'item-prov',
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

    const { manifestRef } = await executor.fire(workItem, { runId: 'run-prov' });

    // The manifestRef must be retrievable from the shared storage (provenance closure).
    expect(manifestRef).toBeDefined();
    const manifestBytes = await storage.get(manifestRef!);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.itemId).toBe('item-prov');
  });
});
