// `dispatchWork(client, work, opts)` — caller-side orchestration for §6 of
// the agora-core spec.
//
// Flow:
//   1. Mint a dispatchId (uuid v4) if not supplied.
//   2. Resolve refs (subagent, env bundles, capabilities) against
//      `client.storage` — short names are looked up via
//      `resolveLatest`; pre-built refs pass through unchanged.
//      `capabilities` REPLACES the subagent's assigned set;
//      `addCapabilities` APPENDS to it (override on conflict). Combining
//      both throws.
//   3. Stage per-dispatch inline secrets via `InlineSecretStager.stage`
//      (TTL flows from `work.timeoutSeconds`). ARN-form secrets pass
//      through unchanged. The result is `Record<envName, ARN>`.
//   4. If `work.callback` is set, mint a per-dispatch HMAC key.
//   5. Resolve provider credentials and select the target's
//      `ComputeProvider`.
//   6. Build the `TaskSpec` — image from `opts.workerImage`, the seven
//      `AGORA_*` env vars per §6.1 plus `AGORA_RUNTIME_ADAPTER`, and
//      `secretRefs` as the merge of env-bundle secrets + per-dispatch
//      secrets (per-dispatch precedence on key conflict per §6.2 step 6).
//   7. `fireWork` calls `provider.run()`; the returned
//      `InFlightDispatch.reconcile()` later calls `provider.awaitExit()`.
//   8. Run `ResultSink.collect()` if set; fall back to a minimal
//      `DispatchResult` built from the exit otherwise.
//   9. Write the dispatch record via `writeDispatchRecord` with the
//      resolved retention days.
//  10. Best-effort cleanup of per-dispatch staged secrets (TTL is the
//      fallback if cleanup fails).

import { randomUUID } from 'node:crypto';
import {
  buildAgoraUri,
  type DispatchWork,
  type DispatchResult,
  type CapabilityRef,
  type SubagentRef,
  type EnvRef,
  type TaskSpec,
  type SecretRef,
  type InlineSecret,
  type TaskHandle,
  type TaskExit,
} from '@quarry-systems/agora-core';
import type { AgoraClient } from './client.js';
import { InlineSecretStager } from './secrets-manager.js';
import { mintCallbackHmac } from './callback-hmac.js';
import { writeDispatchRecord } from './retention.js';

export interface ClientDispatchOpts {
  /** Worker image (digest-pinned) the provider should run. */
  workerImage: string;
  /** Optional fallback for `work.timeoutSeconds` when the caller omits it. */
  defaultDispatchTimeoutSeconds?: number;
}

/**
 * A dispatch that has been *fired* (provider container started) but not yet
 * reconciled. Returned by `fireWork`. The orchestrator (D6 fire-and-reconcile)
 * holds this across ticks; the blocking `dispatchWork` composes it inline.
 *
 *   - `awaitExit()`  — block until the provider task exits (synchronous path).
 *   - `reconcile(exit)` — collect the DispatchResult (sink or minimal) and
 *                         write the dispatch record. Pure of awaiting.
 *   - `cleanup()`    — best-effort sweep of per-dispatch staged secrets;
 *                      never throws (TTL is the fallback).
 */
export interface InFlightDispatch {
  readonly dispatchId: string;
  readonly handle: TaskHandle;
  awaitExit(): Promise<TaskExit>;
  reconcile(exit: TaskExit): Promise<DispatchResult>;
  cleanup(): void;
}

/**
 * Fire a dispatch: resolve refs, stage secrets, mint callback HMAC, select
 * the target's provider, build the TaskSpec, and call `provider.run()`. Returns
 * an `InFlightDispatch` seam the caller reconciles when the task exits. See the
 * file header for the step-by-step flow; the acceptance criteria are encoded in
 * `test/dispatch.test.ts`.
 */
export async function fireWork(
  client: AgoraClient,
  work: DispatchWork,
  opts: ClientDispatchOpts,
): Promise<InFlightDispatch> {
  if (work.capabilities && work.addCapabilities) {
    throw new Error(
      'dispatchWork: cannot combine `capabilities` (replace) with `addCapabilities` (append) on the same call',
    );
  }

  const dispatchId = work.dispatchId ?? randomUUID();
  const effectiveTimeoutSeconds = work.timeoutSeconds ?? opts.defaultDispatchTimeoutSeconds;

  // 1. Resolve refs.
  const resolvedSubagent = await resolveSubagent(client, work.subagent);
  const resolvedEnv = await resolveEnvBundles(client, work.env);
  const resolvedCapabilities = await resolveCapabilities(
    client,
    resolvedSubagent,
    work.capabilities,
    work.addCapabilities,
  );

  // 2. Stage per-dispatch inline secrets. The stager is constructed once
  //    here so cleanup() can sweep every secret tagged with this dispatchId
  //    in a single call.
  const stager = new InlineSecretStager();
  const perDispatchSecretArns: Record<string, string> = {};
  for (const [envName, entry] of Object.entries(work.secrets ?? {})) {
    if (isSecretRef(entry)) {
      perDispatchSecretArns[envName] = entry.arn;
    } else {
      const { arn } = await stager.stage({
        dispatchId,
        envName,
        inline: entry,
        dispatchTimeoutSeconds: effectiveTimeoutSeconds,
      });
      perDispatchSecretArns[envName] = arn;
    }
  }

  // 3. Mint callback HMAC iff a callback URL is configured.
  let callbackTokenArn: string | undefined;
  if (work.callback) {
    const minted = await mintCallbackHmac({
      dispatchId,
      dispatchTimeoutSeconds: effectiveTimeoutSeconds,
    });
    callbackTokenArn = minted.arn;
  }

  // 4. Resolve provider credentials + select compute.
  const targetCfg = client.targets[work.target];
  if (!targetCfg) {
    throw new Error(`dispatchWork: unknown target ${work.target}`);
  }
  const credentialProvider = client.credentials[targetCfg.credentials];
  if (!credentialProvider) {
    throw new Error(
      `dispatchWork: target ${work.target} references unknown credential provider ${targetCfg.credentials}`,
    );
  }
  const compute = client.compute[targetCfg.compute];
  if (!compute) {
    throw new Error(
      `dispatchWork: target ${work.target} references unknown compute provider ${targetCfg.compute}`,
    );
  }
  const credentials = await credentialProvider.resolve();

  // 5. Build TaskSpec.env — bundle-ref descriptors + the seven AGORA_* vars
  //    from §6.1. `callback` injects two extras when configured.
  const bundleRefs = {
    subagent: {
      uri: buildAgoraUri({
        namespace: client.namespace,
        type: 'subagent',
        name: resolvedSubagent.name,
        contentHash: resolvedSubagent.contentHash,
      }),
      contentHash: resolvedSubagent.contentHash,
    },
    capabilities: resolvedCapabilities.map((c) => ({
      uri: buildAgoraUri({
        namespace: client.namespace,
        type: 'capability',
        name: c.name,
        contentHash: c.contentHash,
      }),
      contentHash: c.contentHash,
    })),
    env: resolvedEnv.map((e) => ({
      uri: buildAgoraUri({
        namespace: client.namespace,
        type: 'env',
        name: e.name,
        contentHash: e.contentHash,
      }),
      contentHash: e.contentHash,
    })),
  };

  const envVars: Record<string, string> = {
    AGORA_DISPATCH_ID: dispatchId,
    AGORA_NAMESPACE: client.namespace,
    AGORA_STORAGE_URI: (client.storage as unknown as { rootUri?: string }).rootUri ?? '',
    AGORA_BUNDLE_REFS_JSON: JSON.stringify(bundleRefs),
    AGORA_INPUT_JSON: JSON.stringify(work.input ?? {}),
    AGORA_RUNTIME_ADAPTER: 'claude-code',
  };
  if (work.callback) {
    envVars.AGORA_CALLBACK_URL = work.callback.url;
    // mintCallbackHmac ran above iff work.callback was set, so callbackTokenArn
    // is non-undefined here by construction.
    envVars.AGORA_CALLBACK_TOKEN_REF = callbackTokenArn!;
  }

  // 6. Merge env-bundle secrets + per-dispatch secrets. Per-dispatch wins on
  //    collision per §6.2 step 6 — this is enforced HERE (client-side).
  const envBundleSecretRefs = await flattenEnvBundleSecrets(client, resolvedEnv);
  const secretRefs: Record<string, string> = {
    ...envBundleSecretRefs,
    ...perDispatchSecretArns,
  };

  const taskSpec: TaskSpec = {
    image: opts.workerImage,
    env: envVars,
    secretRefs,
    resources: {
      cpu: work.resources?.cpu ?? targetCfg.defaultResources?.cpu,
      memory: work.resources?.memory ?? targetCfg.defaultResources?.memory,
    },
    dispatchId,
  };

  // 7. Run (fire). awaitExit is deferred to the returned InFlightDispatch.
  const handle = await compute.run(taskSpec, { credentials, telemetry: client.telemetry });
  const startTime = Date.now();
  client.telemetry?.emit({
    kind: 'dispatch.accepted',
    dispatchId,
    target: work.target,
    // ResolvedRefs is currently typed as CapabilityRef[] (see lifecycle.ts —
    // the type alias is a forward-reference placeholder). We echo the
    // capability bundle here; richer shape lands when the placeholder is
    // refined.
    resolved: resolvedCapabilities,
    at: new Date().toISOString(),
  });

  // ── fire complete: container is running. Bundle the reconcile/cleanup
  //    closures so the caller (blocking dispatchWork, or the orchestrator)
  //    can collect the result whenever the task exits. ────────────────────
  const awaitExit = (): Promise<TaskExit> =>
    compute.awaitExit(handle, { credentials, telemetry: client.telemetry });

  const reconcile = async (exit: TaskExit): Promise<DispatchResult> => {
    const durationMs = Date.now() - startTime;

    // 8. ResultSink.collect — or fall back to a minimal DispatchResult.
    const sink = client.resultSink;
    const result: DispatchResult = sink
      ? await sink.collect(handle, exit, {
          dispatchId,
          resolved: {
            subagent: resolvedSubagent,
            capabilities: resolvedCapabilities,
            env: resolvedEnv,
          },
          telemetry: client.telemetry,
        })
      : {
          dispatchId,
          exitCode: exit.exitCode,
          stdout: exit.stdout,
          stderr: exit.stderr,
          durationMs,
          resolved: {
            subagent: resolvedSubagent,
            capabilities: resolvedCapabilities,
            env: resolvedEnv,
          },
        };

    // 9. Write the dispatch record (storage-side retention enforcement).
    await writeDispatchRecord(
      client,
      dispatchId,
      { ...result, providerTaskId: handle.providerTaskId, target: work.target },
      work.retentionDays ?? client.retention.defaultDays,
    );

    return result;
  };

  // 10. Best-effort cleanup of per-dispatch staged secrets. Never throws —
  //     the .catch() preserves the "never throw from cleanup" contract; the
  //     stager's TTL tag is the fallback when cleanup itself fails.
  const cleanup = (): void => {
    stager.cleanup(dispatchId).catch(() => {
      // intentionally suppressed — see above.
    });
  };

  return { dispatchId, handle, awaitExit, reconcile, cleanup };
}

/**
 * Orchestrate a dispatch end-to-end against an `AgoraClient` (blocking).
 * Composed from `fireWork` + `awaitExit` + `reconcile`, with best-effort
 * secret cleanup in `finally`. Behavior is identical to the pre-D9 monolith:
 * cleanup runs whether or not `awaitExit`/`reconcile` throws.
 */
export async function dispatchWork(
  client: AgoraClient,
  work: DispatchWork,
  opts: ClientDispatchOpts,
): Promise<DispatchResult> {
  const inflight = await fireWork(client, work, opts);
  try {
    const exit = await inflight.awaitExit();
    return await inflight.reconcile(exit);
  } finally {
    inflight.cleanup();
  }
}

/** Type guard for the `SecretRef | InlineSecret` discriminated union. */
function isSecretRef(v: SecretRef | InlineSecret): v is SecretRef {
  return 'arn' in v;
}

/**
 * Resolve a subagent reference. Short-name form is looked up via
 * `storage.resolveLatest`; pre-built `SubagentRef`s pass through. Throws
 * if a short name does not resolve.
 */
async function resolveSubagent(
  client: AgoraClient,
  ref: string | SubagentRef,
): Promise<SubagentRef> {
  if (typeof ref !== 'string') {
    return ref;
  }
  const baseUri = buildAgoraUri({
    namespace: client.namespace,
    type: 'subagent',
    name: ref,
  });
  const latest = await client.storage.resolveLatest(baseUri);
  if (!latest) {
    throw new Error(`dispatchWork: subagent not found: ${ref}`);
  }
  return { name: ref, registeredAt: latest.registeredAt, contentHash: latest.contentHash };
}

/**
 * Normalize `work.env` into a list of resolved `EnvRef`s. Accepts the
 * three input shapes (`string`, `EnvRef`, or an array of either) plus
 * `undefined`. Short-name form is looked up via `storage.resolveLatest`.
 */
async function resolveEnvBundles(
  client: AgoraClient,
  refs?: string | EnvRef | Array<string | EnvRef>,
): Promise<EnvRef[]> {
  if (refs === undefined) return [];
  const arr = Array.isArray(refs) ? refs : [refs];
  const out: EnvRef[] = [];
  for (const r of arr) {
    if (typeof r === 'string') {
      const baseUri = buildAgoraUri({
        namespace: client.namespace,
        type: 'env',
        name: r,
      });
      const latest = await client.storage.resolveLatest(baseUri);
      if (!latest) {
        throw new Error(`dispatchWork: env bundle not found: ${r}`);
      }
      out.push({ name: r, registeredAt: latest.registeredAt, contentHash: latest.contentHash });
    } else {
      out.push(r);
    }
  }
  return out;
}

/**
 * Compute the final capability set:
 *   - If `replace` is provided, it fully replaces the subagent's assigned set.
 *   - Otherwise, start from the subagent's assigned set and append `add`,
 *     overriding on logical-name conflict (the appended ref wins).
 *
 * The subagent's currently-assigned capability refs are not available
 * directly from `SubagentRef` (which is identity-only); reading them out of
 * storage requires parsing the subagent blob. That round-trip is implemented
 * here for the `add`-only path.
 */
async function resolveCapabilities(
  client: AgoraClient,
  subagent: SubagentRef,
  replace?: Array<string | CapabilityRef>,
  add?: Array<string | CapabilityRef>,
): Promise<CapabilityRef[]> {
  if (replace) {
    return resolveCapabilityRefs(client, replace);
  }
  const bound = await readSubagentCapabilities(client, subagent);
  if (!add || add.length === 0) {
    return bound;
  }
  const addResolved = await resolveCapabilityRefs(client, add);
  // Override on logical-name conflict: the appended ref replaces any bound
  // ref with the same `name`. Insertion order: bound first, then add.
  const byName = new Map<string, CapabilityRef>();
  for (const c of bound) byName.set(c.name, c);
  for (const c of addResolved) byName.set(c.name, c);
  return Array.from(byName.values());
}

async function resolveCapabilityRefs(
  client: AgoraClient,
  refs: Array<string | CapabilityRef>,
): Promise<CapabilityRef[]> {
  const out: CapabilityRef[] = [];
  for (const r of refs) {
    if (typeof r === 'string') {
      const baseUri = buildAgoraUri({
        namespace: client.namespace,
        type: 'capability',
        name: r,
      });
      const latest = await client.storage.resolveLatest(baseUri);
      if (!latest) {
        throw new Error(`dispatchWork: capability not found: ${r}`);
      }
      out.push({
        name: r,
        registeredAt: latest.registeredAt,
        contentHash: latest.contentHash,
      });
    } else {
      out.push(r);
    }
  }
  return out;
}

/**
 * Read the subagent's currently-bound capabilities by fetching its blob and
 * parsing the canonical definition. The subagent definition stores a list of
 * capability content hashes (sorted); we round-trip those into
 * `CapabilityRef`s by listing the namespace's capabilities and matching by
 * content hash.
 *
 * If the blob can't be parsed or the bound caps can't be re-resolved (e.g.
 * the storage has been GC'd), returns an empty list rather than throwing —
 * the `add`-only path then degrades to "append-only" semantics, which is the
 * least-surprising fallback for a dispatch path that should not fail just
 * because the subagent's prior assignments are no longer addressable.
 */
async function readSubagentCapabilities(
  client: AgoraClient,
  subagent: SubagentRef,
): Promise<CapabilityRef[]> {
  let raw: Uint8Array;
  try {
    const uri = buildAgoraUri({
      namespace: client.namespace,
      type: 'subagent',
      name: subagent.name,
      contentHash: subagent.contentHash,
    });
    raw = await client.storage.get(uri);
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const def = parsed as { capabilities?: unknown };
  if (!Array.isArray(def.capabilities)) return [];
  // The subagent definition stores capabilities as a sorted list of content
  // hashes (see subagent-register.ts). Round-trip each hash to its
  // CapabilityRef via the StorageProvider's `resolveByHash`. Hashes that
  // no longer resolve (e.g. capability was GC'd) are silently dropped —
  // the dispatch proceeds with the remaining capabilities rather than
  // failing the whole call.
  const wantedHashes: string[] = def.capabilities.filter(
    (h): h is string => typeof h === 'string',
  );
  if (wantedHashes.length === 0) return [];
  const hits = await Promise.all(
    wantedHashes.map((contentHash) =>
      client.storage.resolveByHash({
        namespace: client.namespace,
        type: 'capability',
        contentHash,
      }),
    ),
  );
  return hits
    .filter((h): h is NonNullable<typeof h> => h !== null)
    .map((h) => ({
      name: h.name,
      contentHash: h.contentHash,
      registeredAt: h.registeredAt,
    }));
}

/**
 * Fetch every resolved env bundle's stored blob and flatten its
 * `secretRefs: Record<envName, ARN>` map into a single record. Later
 * bundles override earlier on key collision (callers list bundles in
 * priority order).
 */
async function flattenEnvBundleSecrets(
  client: AgoraClient,
  envs: EnvRef[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const env of envs) {
    const uri = buildAgoraUri({
      namespace: client.namespace,
      type: 'env',
      name: env.name,
      contentHash: env.contentHash,
    });
    let bytes: Uint8Array;
    try {
      bytes = await client.storage.get(uri);
    } catch {
      // If the env-bundle blob is missing, skip its secrets rather than
      // fail the entire dispatch — the bundle ref is in the audit trail
      // either way.
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const refs = (parsed as { secretRefs?: unknown }).secretRefs;
    if (!refs || typeof refs !== 'object') continue;
    for (const [k, v] of Object.entries(refs as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}
