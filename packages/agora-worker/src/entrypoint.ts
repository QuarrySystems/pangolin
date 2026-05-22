// agora-worker: 14-step lifecycle orchestrator (§6.2).
//
// `runWorker(env, deps?)` is the single entry point a worker container
// CMD invokes. It ties together every previously-built piece:
//
//   1.  parse env vars + construct StorageProvider
//   2.  load the runtime adapter
//   3.  fetch + integrity-verify bundles
//   4.  resolve callback HMAC key (if configured) + construct LifecycleEmitter
//   5.  emit `dispatch.started`
//   6.  overlay capability bundles to a fresh workspace
//   7.  resolve env-bundle secrets via Secrets Manager
//   8.  merge env (base + bundles + per-dispatch secrets)
//   9.  run agora-setup.sh (if present, time-bounded)
//   10. start the channel subscription (background)
//   11. invoke the runtime adapter
//   12. stop the channel subscription
//   13. resolve the needs_input sentinel (if reported by the adapter)
//   14. fire the appropriate terminal lifecycle event + return exit code
//
// Failure-mode mapping (per task acceptance criteria):
//   - bundle integrity mismatch     → `reason: 'integrity-failed'`
//   - secret resolution error       → `reason: 'fetch-failed'`
//   - setup-script non-zero/timeout → `reason: 'worker-failed'`
//   - malformed/oversized sentinel  → `reason: 'worker-failed'`
//   - valid needs_input sentinel    → `dispatch.needs_input`, exit 0
//   - adapter exit 0, no sentinel   → `dispatch.finished`, exit 0
//   - adapter exit nonzero, no sentinel → `dispatch.failed`, exit nonzero
//
// `RunWorkerDeps` is an injection seam that exists exclusively for tests.
// Production callers pass nothing and accept the defaults: the worker
// constructs its own StorageProvider, loads its adapter from
// `/opt/agora/adapters/<name>`, mkdtemps a fresh workspace, uses the
// default AWS Secrets Manager client, and writes lifecycle events to the
// `LifecycleEmitter` (which talks to AGORA_CALLBACK_URL).

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  LifecycleEvent,
  RuntimeAdapter,
  StorageProvider,
  NotificationConfig,
} from '@quarry-systems/agora-core';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

import { parseWorkerEnv, type WorkerConfig } from './env-parser.js';
import { loadRuntimeAdapter } from './adapter-loader.js';
import {
  constructStorageProvider,
  fetchBundles,
  type FetchedBundles,
  type FetchedCapability,
} from './bundle-fetcher.js';
import {
  overlayCapabilities,
  type CapabilityBundle,
} from './overlay-engine.js';
import { SecretResolver, SecretResolutionError } from './secret-resolver.js';
import { mergeEnv, type EnvBundle } from './env-merger.js';
import {
  runSetupScriptIfPresent,
  SetupScriptError,
} from './setup-script.js';
import {
  loadChannelIfPresent,
  type ChannelHandle,
} from './channel-loader.js';
import { resolveNeedsInputSentinel } from './needs-input.js';
import {
  loadCapabilityNotifications,
  fireNotifications,
} from './notifications.js';
import { LifecycleEmitter } from './lifecycle.js';
import { StructuredLogger } from './logger.js';

/**
 * Injection seam for tests. Every field is optional; production callers
 * pass `undefined` (or omit `deps` entirely) and accept the documented
 * defaults.
 */
export interface RunWorkerDeps {
  /** Pre-built StorageProvider. Default: derived from AGORA_STORAGE_URI. */
  storage?: StorageProvider;
  /** Pre-built RuntimeAdapter. Default: loaded from `adaptersRoot`. */
  adapter?: RuntimeAdapter;
  /** Override the adapters discovery root. Default: `/opt/agora/adapters`. */
  adaptersRoot?: string;
  /** Pre-allocated workspace directory. Default: mkdtemp under os.tmpdir(). */
  workspaceDir?: string;
  /** Secrets Manager client (for env-bundle secret resolution). */
  secretsManagerClient?: SecretsManagerClient;
  /**
   * Synchronous lifecycle observer. Receives every emitted event before it
   * is dispatched to the LifecycleEmitter / notification webhooks. Exists
   * so tests can capture event ordering without spinning up a mock fetch.
   */
  onLifecycleEvent?: (event: LifecycleEvent) => void;
  /** Override the global fetch (lifecycle + notification webhooks). */
  fetchImpl?: typeof fetch;
}

/**
 * Run the worker end-to-end. Returns the exit code the container should
 * exit with: 0 on success or on a valid `needs_input` sentinel, the
 * adapter's exit code on a non-zero runtime exit, and 1 for any worker-side
 * failure (integrity, fetch, setup, sentinel parsing).
 */
export async function runWorker(
  env: NodeJS.ProcessEnv = process.env,
  deps: RunWorkerDeps = {},
): Promise<number> {
  const logger = new StructuredLogger();
  const startTime = Date.now();

  // Step 1: parse env. A parse failure is a worker bug — there is no
  // emitter yet, so just log and exit non-zero.
  let cfg: WorkerConfig;
  try {
    cfg = parseWorkerEnv(env);
  } catch (err) {
    logger.log({
      kind: 'worker.boot.failed',
      detail: (err as Error).message,
    });
    return 1;
  }
  logger.log({ kind: 'worker.boot', dispatchId: cfg.dispatchId });

  // The LifecycleEmitter is built up-front so failure paths can emit
  // `dispatch.failed` even if later steps short-circuit. It is a no-op
  // when no callback URL is configured.
  // Per spec, when AGORA_CALLBACK_URL is set, AGORA_CALLBACK_TOKEN_REF
  // names a Secrets Manager ARN holding the HMAC key. We resolve it lazily
  // below so an integrity failure on the very first bundle still surfaces.
  let lifecycleEmitter = new LifecycleEmitter({
    callbackUrl: cfg.callbackUrl,
    hmacKey: undefined,
    fetchImpl: deps.fetchImpl,
  });
  // notification configs are loaded post-overlay (step 11). Until then,
  // `dispatch.failed` events fire on the lifecycle webhook only.
  let capabilityNotifications: NotificationConfig[] = [];
  const dispatchLevelNotifications: NotificationConfig[] = [];
  let hmacKeyForNotifications = '';

  const emit = async (event: LifecycleEvent): Promise<void> => {
    deps.onLifecycleEvent?.(event);
    try {
      await lifecycleEmitter.emit(event);
    } catch (err) {
      logger.log({
        kind: 'lifecycle.emit.failed',
        detail: (err as Error).message,
      });
    }
    if (capabilityNotifications.length > 0 || dispatchLevelNotifications.length > 0) {
      await fireNotifications({
        event,
        sources: [capabilityNotifications, dispatchLevelNotifications],
        hmacKey: hmacKeyForNotifications,
        fetchImpl: deps.fetchImpl,
      });
    }
  };

  const failWith = async (
    reason: 'integrity-failed' | 'fetch-failed' | 'worker-failed',
    detail: string,
    exitCode = 1,
  ): Promise<number> => {
    // Keep the lifecycle event's `reason` to the canonical token (one of
    // the six §4.3 failure reasons) so subscribers can switch on it. The
    // long-form detail goes only into the worker log — that way redacted
    // secrets in `detail` never get POSTed to a webhook.
    logger.log({ kind: 'dispatch.failed', dispatchId: cfg.dispatchId, reason, detail });
    await emit({
      kind: 'dispatch.failed',
      dispatchId: cfg.dispatchId,
      reason,
      at: new Date().toISOString(),
    });
    return exitCode;
  };

  // Step 1b: construct StorageProvider.
  let storage: StorageProvider;
  try {
    storage = deps.storage ?? (await constructStorageProvider(cfg.storageUri));
  } catch (err) {
    return failWith('worker-failed', `storage construction failed: ${(err as Error).message}`);
  }

  // Step 2: load runtime adapter.
  let adapter: RuntimeAdapter;
  try {
    adapter = deps.adapter
      ?? (await loadRuntimeAdapter(cfg.runtimeAdapter, {
        adaptersRoot: deps.adaptersRoot,
      }));
  } catch (err) {
    return failWith('worker-failed', `adapter load failed: ${(err as Error).message}`);
  }

  // Step 3: fetch + integrity-verify bundles.
  let bundles: FetchedBundles;
  try {
    bundles = await fetchBundles(cfg.bundleRefs, storage);
  } catch (err) {
    return failWith(
      'integrity-failed',
      `bundle fetch/verify failed: ${(err as Error).message}`,
    );
  }

  // Step 4: resolve the callback HMAC key (if a callback is configured).
  const secretsClient =
    deps.secretsManagerClient ?? new SecretsManagerClient({});
  if (cfg.callbackUrl && cfg.callbackTokenRef) {
    try {
      const res = await secretsClient.send(
        new GetSecretValueCommand({ SecretId: cfg.callbackTokenRef }),
      );
      const key = res.SecretString;
      if (!key) {
        return failWith(
          'fetch-failed',
          `callback HMAC key for ${cfg.callbackTokenRef} has empty SecretString`,
        );
      }
      logger.registerSecret(key);
      hmacKeyForNotifications = key;
      lifecycleEmitter = new LifecycleEmitter({
        callbackUrl: cfg.callbackUrl,
        hmacKey: key,
        fetchImpl: deps.fetchImpl,
      });
    } catch (err) {
      return failWith(
        'fetch-failed',
        `callback HMAC key fetch failed: ${(err as Error).message}`,
      );
    }
  }

  // Step 5: emit dispatch.started.
  await emit({
    kind: 'dispatch.started',
    dispatchId: cfg.dispatchId,
    providerTaskId: cfg.dispatchId,
    at: new Date().toISOString(),
  });

  // Step 6: overlay capabilities to a fresh workspace.
  const workspaceDir =
    deps.workspaceDir ?? (await mkdtemp(join(tmpdir(), 'agora-workspace-')));
  try {
    const capabilityBundles: CapabilityBundle[] = bundles.capabilities.map(
      (c: FetchedCapability) => ({
        name: c.name,
        files: unpackBundle(c.bytes),
      }),
    );
    await overlayCapabilities({
      workspaceDir,
      bundles: capabilityBundles,
      adapter,
    });
  } catch (err) {
    return failWith(
      'integrity-failed',
      `overlay failed: ${(err as Error).message}`,
    );
  }

  // Post-overlay: load capability-content notifications so failure paths
  // beyond this point notify subscribers too.
  try {
    capabilityNotifications = await loadCapabilityNotifications(workspaceDir);
  } catch (err) {
    logger.log({
      kind: 'notifications.load.failed',
      detail: (err as Error).message,
    });
  }

  // Step 7: resolve env-bundle secrets.
  const envBundles: EnvBundle[] = [];
  const secretResolver = new SecretResolver({ client: secretsClient });
  for (const envBundle of bundles.envs) {
    const def = envBundle.def as {
      values?: Record<string, string>;
      secretRefs?: Record<string, string>;
    };
    let resolvedSecrets: Record<string, string> = {};
    if (def.secretRefs && Object.keys(def.secretRefs).length > 0) {
      try {
        resolvedSecrets = await secretResolver.resolve(def.secretRefs);
      } catch (err) {
        if (err instanceof SecretResolutionError) {
          return failWith(
            'fetch-failed',
            `env-bundle ${envBundle.name} secret: ${err.message}`,
          );
        }
        return failWith(
          'fetch-failed',
          `env-bundle ${envBundle.name} secret resolution: ${(err as Error).message}`,
        );
      }
    }
    for (const v of Object.values(resolvedSecrets)) {
      logger.registerSecret(v);
    }
    envBundles.push({ values: def.values ?? {}, secrets: resolvedSecrets });
  }

  // Step 8: merge env. The worker's own process.env is the base — AWS SDK,
  // PATH, HOME, etc. all need to survive into the child runtime. Per-dispatch
  // secrets are injected by the compute layer (e.g. Fargate ECS) directly
  // into the worker's process.env, so they are already present in `env`.
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) baseEnv[k] = v;
  }
  const mergedEnv = mergeEnv({
    envBundles,
    perDispatchSecrets: {},
    baseEnv,
  });

  // Step 9: run agora-setup.sh if present. The captured stdout/stderr are
  // surfaced via the structured logger per §6.3 so an integrator can see the
  // setup script's output in the worker's stream (the `setup-script.ran`
  // event) without having to also rebuild the worker to stream the script
  // stdout live.
  try {
    const setupResult = await runSetupScriptIfPresent({
      workspaceDir,
      env: mergedEnv,
      timeoutSeconds: cfg.setupTimeoutSeconds,
    });
    if (setupResult) {
      logger.log({
        kind: 'setup-script.ran',
        exitCode: setupResult.exitCode,
        durationMs: setupResult.durationMs,
        stdout: setupResult.stdout,
        stderr: setupResult.stderr,
      });
    }
  } catch (err) {
    if (err instanceof SetupScriptError) {
      return failWith(
        'worker-failed',
        `setup-script exit ${err.result.exitCode}: ${err.result.stderr.slice(0, 500)}`,
      );
    }
    return failWith(
      'worker-failed',
      `setup-script failed: ${(err as Error).message}`,
    );
  }

  // Step 10: start the channel subscription (background; fire and forget).
  let channel: ChannelHandle | null = null;
  try {
    channel = await loadChannelIfPresent({
      workspaceDir,
      adaptersRoot: deps.adaptersRoot,
    });
  } catch (err) {
    logger.log({
      kind: 'channel.load.failed',
      detail: (err as Error).message,
    });
  }

  // Step 11: invoke the runtime adapter. Channel teardown (step 12) lives
  // in a `finally` block so it runs whether invoke succeeds, throws, or
  // returns a non-zero exit.
  const subagent = bundles.subagentDef as {
    systemPrompt?: string;
    promptTemplate?: string;
    model?: string;
  };
  let runtimeExit;
  try {
    runtimeExit = await adapter.invoke(
      {
        systemPrompt: subagent.systemPrompt,
        promptTemplate: subagent.promptTemplate,
        input: cfg.inputJson,
        model: subagent.model,
        workspaceDir,
      },
      {
        dispatchId: cfg.dispatchId,
        env: mergedEnv,
      },
    );
  } catch (err) {
    // The runtime adapter itself blew up — that is a worker failure, not a
    // dispatch failure: the adapter is part of the worker image.
    return failWith(
      'worker-failed',
      `runtime adapter threw: ${(err as Error).message}`,
    );
  } finally {
    // Step 12: stop the channel subscription. Always runs — even on the
    // catch above's early return — so the background loop never leaks.
    if (channel) await channel.stop();
  }

  // Step 13: needs_input sentinel resolution.
  if (runtimeExit.needsInputSentinelPath) {
    const outcome = await resolveNeedsInputSentinel(
      runtimeExit.needsInputSentinelPath,
    );
    if (outcome.kind === 'malformed') {
      return failWith('worker-failed', `needs_input sentinel malformed: ${outcome.detail}`);
    }
    if (outcome.kind === 'oversized') {
      return failWith(
        'worker-failed',
        `needs_input sentinel oversized: ${outcome.sizeBytes} bytes`,
      );
    }
    // Valid needs_input: emit and exit 0.
    await emit({
      kind: 'dispatch.needs_input',
      dispatchId: cfg.dispatchId,
      durationMs: Date.now() - startTime,
      at: new Date().toISOString(),
    });
    logger.log({
      kind: 'dispatch.needs_input',
      dispatchId: cfg.dispatchId,
      question: outcome.payload.question,
    });
    return 0;
  }

  // Step 14: terminal lifecycle event + exit code.
  if (runtimeExit.exitCode === 0) {
    await emit({
      kind: 'dispatch.finished',
      dispatchId: cfg.dispatchId,
      exitCode: 0,
      durationMs: Date.now() - startTime,
      at: new Date().toISOString(),
    });
    return 0;
  }

  // Non-zero runtime exit with no sentinel is a `dispatch.failed`. We carry
  // the runtime's exit code out as the worker's exit code so the compute
  // layer can surface application-level non-zero exits accurately. The
  // canonical reason is `provider-failed` (per §4.3) — the runtime ran but
  // produced a non-zero exit unrelated to worker infrastructure.
  logger.log({
    kind: 'dispatch.failed',
    dispatchId: cfg.dispatchId,
    reason: 'provider-failed',
    detail: `runtime exited with code ${runtimeExit.exitCode}`,
    stderr: runtimeExit.stderr.slice(0, 500),
  });
  await emit({
    kind: 'dispatch.failed',
    dispatchId: cfg.dispatchId,
    reason: 'provider-failed',
    at: new Date().toISOString(),
  });
  return runtimeExit.exitCode;
}

/**
 * Inverse of `agora-client.serializeCapabilityBundle`.
 *
 * Layout (header line + concatenated bytes per entry):
 *
 *   <JSON header>\n<bytes for entries[0]><bytes for entries[1]>...
 *
 * Where `<JSON header>` is `{"name": ..., "entries": [{"path": ..., "size": N}, ...]}`
 * with entries sorted lexicographically by path. We read up to the first
 * `\n`, parse the header, then slice the trailing region into per-file
 * blobs using `size`.
 */
function unpackBundle(bytes: Uint8Array): Record<string, Uint8Array> {
  let newlineIdx = -1;
  for (let i = 0; i < bytes.byteLength; i++) {
    if (bytes[i] === 0x0a /* \n */) {
      newlineIdx = i;
      break;
    }
  }
  if (newlineIdx === -1) {
    throw new Error('capability bundle missing header newline');
  }
  const headerText = new TextDecoder().decode(bytes.subarray(0, newlineIdx));
  let header: { name?: string; entries?: Array<{ path: string; size: number }> };
  try {
    header = JSON.parse(headerText);
  } catch (err) {
    throw new Error(
      `capability bundle header is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!header.entries || !Array.isArray(header.entries)) {
    throw new Error('capability bundle header missing entries[]');
  }
  const files: Record<string, Uint8Array> = {};
  let offset = newlineIdx + 1;
  for (const entry of header.entries) {
    if (typeof entry.path !== 'string' || typeof entry.size !== 'number') {
      throw new Error('capability bundle entry missing path or size');
    }
    const end = offset + entry.size;
    if (end > bytes.byteLength) {
      throw new Error(
        `capability bundle entry ${entry.path} declared size ${entry.size} exceeds remaining bytes`,
      );
    }
    files[entry.path] = bytes.subarray(offset, end);
    offset = end;
  }
  return files;
}
