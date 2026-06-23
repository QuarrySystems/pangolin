// IN-PROCESS COMPUTE PROVIDER — fakes the container boundary for a $0 dispatch.
//
// A ComputeProvider whose `run()` executes pangolin-worker's runWorker() IN-PROCESS
// instead of starting a Docker container. The REAL PangolinClient dispatch path runs
// upstream of this — capability resolution + pinning, env firewall, secret staging,
// and manifest sealing all happen exactly as in production. We only swap the very
// last hop (container start → in-proc call) and the model (via the injected fake
// RuntimeAdapter). That faithfulness is the point: it exercises everything the live
// gated run does EXCEPT spending credits, and capability-bearing subagents Just Work
// because the client already pinned their bundles into spec.env.
//
// The client assembles spec.env (PANGOLIN_BUNDLE_REFS_JSON with capabilities, the
// storage URI, secret dir, model, trace). We hand spec.env straight to runWorker and
// inject the SAME storage + secretStore instances the client used, so bundle fetch
// and secret resolution hit the same backing store with no bind-mount rewrite needed.
//
// NOT a production provider. No image-pin check, no isolation — example-local only.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ComputeProvider,
  ProviderContext,
  TaskExit,
  TaskHandle,
  TaskSpec,
  StorageProvider,
  SecretStore,
  RuntimeAdapter,
} from '@quarry-systems/pangolin-core';
import { runWorker } from '@quarry-systems/pangolin-worker';

export interface InprocComputeProviderOptions {
  /** The SAME StorageProvider the client registers bundles to (so the worker reads them). */
  storage: StorageProvider;
  /** The SAME SecretStore the client stages secrets to (so the worker resolves refs). */
  secretStore: SecretStore;
  /** Fake runtime adapter — what replaces the real `claude` CLI. */
  adapter: RuntimeAdapter;
}

export class InprocComputeProvider implements ComputeProvider {
  readonly name = 'inproc';
  private readonly storage: StorageProvider;
  private readonly secretStore: SecretStore;
  private readonly adapter: RuntimeAdapter;
  // dispatchId → the in-flight worker run, so awaitExit can join it.
  private readonly inflight = new Map<string, Promise<TaskExit>>();

  constructor(opts: InprocComputeProviderOptions) {
    this.storage = opts.storage;
    this.secretStore = opts.secretStore;
    this.adapter = opts.adapter;
  }

  async run(spec: TaskSpec, _ctx: ProviderContext): Promise<TaskHandle> {
    const startedAt = new Date();
    const run = (async (): Promise<TaskExit> => {
      const workspaceDir = await mkdtemp(join(tmpdir(), 'inproc-ws-'));
      try {
        // deps.storage / deps.secretStore / deps.adapter override what the worker
        // would otherwise construct from spec.env — so the file:// storage URI and
        // secret-dir in spec.env need no container bind-mount rewrite.
        const exitCode = await runWorker(spec.env, {
          storage: this.storage,
          secretStore: this.secretStore,
          adapter: this.adapter,
          workspaceDir,
        });
        return { exitCode, startedAt, finishedAt: new Date(), stdout: '', stderr: '' };
      } catch (err) {
        // Infrastructural failure (the worker threw rather than exiting non-zero).
        return {
          exitCode: 1,
          startedAt,
          finishedAt: new Date(),
          stdout: '',
          stderr: String(err),
          providerFailureReason: `inproc worker threw: ${String(err)}`,
        };
      } finally {
        await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
      }
    })();
    this.inflight.set(spec.dispatchId, run);
    return { providerTaskId: spec.dispatchId };
  }

  async awaitExit(handle: TaskHandle, _ctx: ProviderContext): Promise<TaskExit> {
    const run = this.inflight.get(handle.providerTaskId);
    if (!run) {
      throw new Error(`InprocComputeProvider: no in-flight run for ${handle.providerTaskId}`);
    }
    try {
      return await run;
    } finally {
      this.inflight.delete(handle.providerTaskId);
    }
  }
}
