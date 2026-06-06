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
//   3. Stage per-dispatch inline secrets via the target's injected
//      `SecretStore`. `SecretRef`-form secrets pass through unchanged.
//      The result is `Record<envName, ref>`.
//   4. If `work.callback` is set, mint a per-dispatch HMAC key via the
//      target's store.
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
//  10. Best-effort cleanup of per-dispatch staged secrets via
//      `store.cleanupByTag` (TTL is the fallback if cleanup fails).

import { randomUUID } from 'node:crypto';
import {
  buildAgoraUri,
  parseAgoraUri,
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
  type SecretStore,
} from '@quarry-systems/agora-core';
import type { AgoraClient } from './client.js';
import { computeInlineSecretTtl } from './secret-ttl.js';
import { mintCallbackHmac } from './callback-hmac.js';
import { writeDispatchRecord } from './retention.js';
import { SecretStoreMismatchError } from './errors.js';

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
  /** Resolved inputs + environment for this dispatch — content-addressed refs
   *  and secret REFERENCES only (no values). Used to build the audit manifest. */
  readonly resolved: {
    subagent: SubagentRef;
    capabilities: CapabilityRef[];
    env: EnvRef[];
    secretRefs: Record<string, string>; // envName -> ref (references, never values)
    workerImage: string;
    inputRefs: Record<string, string>; // key -> already-pinned agora:// URI (Wave-C manifest)
    /** for the audit manifest — the pinned pipeline definition URI that triggered this dispatch */
    pipelineRef?: string;
  };
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

  // 2. Resolve the target's injected SecretStore. The store is used to
  //    stage per-dispatch inline secrets and the callback HMAC key.
  //    A missing store is only an error if the dispatch actually needs one.
  const targetCfg = client.targets[work.target];
  if (!targetCfg) {
    throw new Error(`dispatchWork: unknown target ${work.target}`);
  }
  const store = targetCfg.secretStore ? client.secretStores[targetCfg.secretStore] : undefined;
  const needsStore =
    Object.values(work.secrets ?? {}).some((e) => !isSecretRef(e)) || !!work.callback;
  if (needsStore && !store) {
    throw new Error(
      `dispatchWork: target ${work.target} stages secrets but has no secretStore configured`,
    );
  }

  // 3. Stage per-dispatch inline secrets via the injected store.
  //    SecretRef-form entries pass through with their `ref` unchanged.
  const perDispatchSecretRefs: Record<string, string> = {};
  for (const [envName, entry] of Object.entries(work.secrets ?? {})) {
    if (isSecretRef(entry)) {
      perDispatchSecretRefs[envName] = entry.ref;
      continue;
    }
    const { ref } = await store!.stage({
      name: `${dispatchId}/${envName}`,
      value: entry.inline,
      ttlSeconds: computeInlineSecretTtl({
        explicit: entry.ttlSeconds,
        dispatchTimeoutSeconds: effectiveTimeoutSeconds,
      }),
      tags: { 'agora:dispatchId': dispatchId },
    });
    perDispatchSecretRefs[envName] = ref;
  }

  // 4. Mint callback HMAC iff a callback URL is configured.
  let callbackTokenRef: string | undefined;
  if (work.callback) {
    const minted = await mintCallbackHmac({
      store: store!,
      dispatchId,
      dispatchTimeoutSeconds: effectiveTimeoutSeconds,
    });
    callbackTokenRef = minted.ref;
  }

  // 5. Resolve provider credentials + select compute.
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

  // 6. Build TaskSpec.env — bundle-ref descriptors + the seven AGORA_* vars
  //    from §6.1. `callback` injects two extras when configured.
  //
  // Resolve inputRefs BEFORE the container starts: parse each URI with
  // parseAgoraUri (rejects malformed URIs) and verify the URI is pinned
  // (has a contentHash segment). This is pure pass-through — the blobs
  // already exist in storage (typed-product handoff, spec §5).
  const resolvedInputRefs: Array<{ key: string; uri: string; contentHash: string }> =
    Object.entries(work.inputRefs ?? {}).map(([key, uri]) => {
      const { contentHash } = parseAgoraUri(uri); // throws on malformed
      if (!contentHash) {
        throw new Error(
          `dispatch: inputRefs['${key}'] must be a pinned agora:// URI (missing content hash): ${uri}`,
        );
      }
      return { key, uri, contentHash };
    });

  // Validate pipelineRef when present — EXACTLY like inputRefs entries.
  // parseAgoraUri throws on malformed; missing contentHash is an explicit error.
  let resolvedPipelineRef: { uri: string; contentHash: string } | undefined;
  if (work.pipelineRef !== undefined) {
    const { contentHash } = parseAgoraUri(work.pipelineRef); // throws on malformed
    if (!contentHash) {
      throw new Error(
        `dispatch: pipelineRef must be a pinned agora:// URI (missing content hash): ${work.pipelineRef}`,
      );
    }
    resolvedPipelineRef = { uri: work.pipelineRef, contentHash };
  }

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
    inputs: resolvedInputRefs,
    ...(resolvedPipelineRef !== undefined ? { pipeline: resolvedPipelineRef } : {}),
  };

  const envVars: Record<string, string> = {
    AGORA_DISPATCH_ID: dispatchId,
    AGORA_NAMESPACE: client.namespace,
    AGORA_STORAGE_URI: hasRootUri(client.storage) ? client.storage.rootUri : '',
    AGORA_BUNDLE_REFS_JSON: JSON.stringify(bundleRefs),
    AGORA_INPUT_JSON: JSON.stringify(work.input ?? {}),
    AGORA_RUNTIME_ADAPTER: 'claude-code',
    // Per-dispatch secret refs travel to the worker so the WORKER resolves
    // and registers them for log redaction (§7.1) — rather than the compute
    // layer injecting them as ambient env that escapes redaction. Only the
    // per-dispatch map goes here; env-bundle secrets are resolved by the
    // worker from the env-bundle blob to avoid double-resolution.
    AGORA_PER_DISPATCH_SECRET_REFS_JSON: JSON.stringify(perDispatchSecretRefs),
  };
  // Emit the store kind and (when set) the on-disk directory so the provider
  // can bind-mount it into the worker container.
  if (store) {
    envVars.AGORA_SECRET_STORE_KIND = store.name;
    if (store.dir) {
      envVars.AGORA_SECRET_STORE_DIR = store.dir;
    }
  }
  if (work.callback) {
    envVars.AGORA_CALLBACK_URL = work.callback.url;
    // mintCallbackHmac ran above iff work.callback was set, so callbackTokenRef
    // is non-undefined here by construction.
    envVars.AGORA_CALLBACK_TOKEN_REF = callbackTokenRef!;
  }

  // 7. Merge env-bundle secrets + per-dispatch secrets. Per-dispatch wins on
  //    collision per §6.2 step 6 — this is enforced HERE (client-side).
  const envBundleSecretRefs = await flattenEnvBundleSecrets(client, resolvedEnv, store);
  const secretRefs: Record<string, string> = {
    ...envBundleSecretRefs,
    ...perDispatchSecretRefs,
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

  // 8. Run (fire). awaitExit is deferred to the returned InFlightDispatch.
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

    // 9. ResultSink.collect — or fall back to a minimal DispatchResult.
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

    // 10. Write the dispatch record (storage-side retention enforcement).
    await writeDispatchRecord(
      client,
      dispatchId,
      { ...result, providerTaskId: handle.providerTaskId, target: work.target },
      work.retentionDays ?? client.retention.defaultDays,
    );

    return result;
  };

  // 11. Best-effort cleanup of per-dispatch staged secrets. Never throws —
  //     the .catch() preserves the "never throw from cleanup" contract.
  //     The injected store's cleanupByTag sweeps by dispatch-id tag; TTL is
  //     the fallback if cleanup fails or no store is configured. Runs on
  //     success and on throw (finally).
  const cleanup = (): void => {
    store?.cleanupByTag('agora:dispatchId', dispatchId).catch(() => {
      // intentionally suppressed — see above.
    });
  };

  return {
    dispatchId,
    handle,
    resolved: {
      subagent: resolvedSubagent,
      capabilities: resolvedCapabilities,
      env: resolvedEnv,
      secretRefs,
      workerImage: opts.workerImage,
      inputRefs: work.inputRefs ?? {},
      ...(resolvedPipelineRef !== undefined ? { pipelineRef: resolvedPipelineRef.uri } : {}),
    },
    awaitExit,
    reconcile,
    cleanup,
  };
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
  return 'ref' in v;
}

/** Narrowing guard: storage implementations may optionally expose a `rootUri`
 *  string (used to populate `AGORA_STORAGE_URI`). */
function hasRootUri(x: unknown): x is { rootUri: string } {
  return (
    typeof x === 'object' &&
    x !== null &&
    'rootUri' in x &&
    typeof (x as { rootUri: unknown }).rootUri === 'string'
  );
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
  const out: CapabilityRef[]= [];
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
 *
 * Throws `SecretStoreMismatchError` when a bundle's recorded `store` kind
 * differs from `targetStore?.name`. Bundles with no recorded `store` field
 * (values-only / ref-only / legacy) skip the check.
 */
async function flattenEnvBundleSecrets(
  client: AgoraClient,
  envs: EnvRef[],
  targetStore: SecretStore | undefined,
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
    const def = parsed as { secretRefs?: unknown; store?: unknown };
    // Guard: if the bundle recorded which store kind it was staged for,
    // verify it matches the dispatch target's store. Bundles with no
    // recorded `store` field (values-only / ref-only / legacy) skip the check.
    const bundleKind = typeof def.store === 'string' ? def.store : undefined;
    if (bundleKind !== undefined && bundleKind !== targetStore?.name) {
      throw new SecretStoreMismatchError(env.name, bundleKind, targetStore?.name);
    }
    const refs = def.secretRefs;
    if (!refs || typeof refs !== 'object') continue;
    for (const [k, v] of Object.entries(refs as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}
