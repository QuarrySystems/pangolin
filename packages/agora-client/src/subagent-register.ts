// `subagent.register(opts)` + `SubagentHandle.assign()` — caller-side
// helpers for §4.1.2 of the agora-core spec.
//
// Behavior summary:
//   - `register` accepts an optional `capabilities` list of either bare
//     names (resolved against `client.storage.resolveLatest`) or fully-
//     materialized CapabilityRefs.
//   - The content hash is computed over a canonical definition object
//     consisting of `(name, systemPrompt, promptTemplate, model,
//     sorted resolved capability hashes)`.
//   - If the same content hash is already registered, the existing
//     `registeredAt` is returned and no duplicate put is issued
//     (idempotent).
//   - The returned `SubagentHandle.assign(caps)` re-registers the
//     subagent with a different capability set, producing a NEW pinned
//     version — both old and new versions coexist immutably in storage.

import {
  buildAgoraUri,
  canonicalJsonString,
  computeContentHash,
  type CapabilityRef,
  type SubagentRef,
  type SubagentHandle,
  type VerifyConfig,
} from '@quarry-systems/agora-core';
import type { AgoraClient } from './client.js';

/** Options to `registerSubagent`. */
export interface RegisterSubagentOpts {
  name: string;
  systemPrompt?: string;
  promptTemplate?: string;
  model?: string;
  capabilities?: Array<string | CapabilityRef>;
  /**
   * Optional self-verify command (Gap A). When set, the worker runs this
   * (language-agnostic) shell command over its edit and seals pass/fail into
   * the output sentinel. Carried verbatim into the stored subagent def so the
   * worker can read it; omitted entirely when absent (hash-stable for
   * subagents that don't use it).
   */
  verify?: VerifyConfig;
}

/**
 * Register a subagent template against the client's storage. Returns a
 * {@link SubagentHandle} that can re-register the subagent under a new
 * capability set via `.assign(...)`.
 *
 * Throws when neither `systemPrompt` nor `promptTemplate` is provided,
 * or when a short-name capability ref cannot be resolved via
 * `client.storage.resolveLatest`.
 */
export async function registerSubagent(
  client: AgoraClient,
  opts: RegisterSubagentOpts,
): Promise<SubagentHandle> {
  if (!opts.systemPrompt && !opts.promptTemplate) {
    throw new Error(
      'subagent.register: at least one of systemPrompt or promptTemplate is required',
    );
  }

  const resolvedCaps = await resolveCapabilityRefs(client, opts.capabilities ?? []);

  // Canonical definition for hashing: sort capability hashes so set-ordering
  // doesn't perturb the resulting subagent identity.
  const sortedCapHashes = resolvedCaps.map((c) => c.contentHash).sort();
  const def: Record<string, unknown> = {
    name: opts.name,
    systemPrompt: opts.systemPrompt ?? null,
    promptTemplate: opts.promptTemplate ?? null,
    model: opts.model ?? null,
    capabilities: sortedCapHashes,
  };
  // Additive + hash-stable: only present when set, so existing subagents
  // (no verify) keep their exact content hash.
  if (opts.verify) def.verify = opts.verify;
  const contentHash = computeContentHash(def);

  const baseUri = buildAgoraUri({
    namespace: client.namespace,
    type: 'subagent',
    name: opts.name,
  });
  const pinnedUri = buildAgoraUri({
    namespace: client.namespace,
    type: 'subagent',
    name: opts.name,
    contentHash,
  });

  // Idempotency check: if the latest registration for this logical name
  // already matches this content hash, reuse its registeredAt and skip
  // the storage write.
  const latest = await client.storage.resolveLatest(baseUri);
  let registeredAt: string;
  if (latest && latest.contentHash === contentHash) {
    registeredAt = latest.registeredAt;
  } else {
    // Write the CANONICAL JSON bytes (sorted-key serialization) — not
    // `JSON.stringify(def)`. The storage provider recomputes the byte-hash
    // and compares against the pinned URI's hash; if we wrote insertion-
    // order JSON, the byte-hash would diverge from the canonical-object
    // hash embedded in the URI and `put` would throw IntegrityMismatchError.
    // The worker's bundle-fetcher re-parses these bytes as JSON and
    // re-hashes the resulting object via canonical JSON, so the round-trip
    // remains coherent on both sides.
    await client.storage.put(
      pinnedUri,
      new TextEncoder().encode(canonicalJsonString(def)),
    );
    // The storage layer is the authority on registeredAt — re-read it.
    // If resolveLatest returns null here, the storage provider is inconsistent
    // (a put just succeeded for this name); fail fast rather than inventing a
    // local timestamp, which would silently violate the storage-as-authority
    // contract.
    const after = await client.storage.resolveLatest(baseUri);
    if (!after) {
      throw new Error(
        `storage.resolveLatest returned null immediately after put: ${pinnedUri}. Storage provider may be inconsistent.`,
      );
    }
    registeredAt = after.registeredAt;
  }

  const ref: SubagentRef = { name: opts.name, registeredAt, contentHash };
  const handle: SubagentHandle = {
    ...ref,
    assign: async (capabilities: Array<string | CapabilityRef>): Promise<SubagentRef> => {
      const evolved = await registerSubagent(client, { ...opts, capabilities });
      // Strip the assign() function so the returned value is a plain SubagentRef
      // (handles are not serializable; refs are).
      return { name: evolved.name, registeredAt: evolved.registeredAt, contentHash: evolved.contentHash };
    },
  };
  return handle;
}

/**
 * Normalize a list of `(string | CapabilityRef)` into concrete
 * `CapabilityRef`s by resolving any bare names against the client's
 * storage. Throws if a name cannot be resolved.
 */
async function resolveCapabilityRefs(
  client: AgoraClient,
  refs: Array<string | CapabilityRef>,
): Promise<CapabilityRef[]> {
  const resolved: CapabilityRef[] = [];
  for (const ref of refs) {
    if (typeof ref === 'string') {
      const baseUri = buildAgoraUri({
        namespace: client.namespace,
        type: 'capability',
        name: ref,
      });
      const latest = await client.storage.resolveLatest(baseUri);
      if (!latest) {
        throw new Error(`capability not found: ${ref}`);
      }
      resolved.push({
        name: ref,
        registeredAt: latest.registeredAt,
        contentHash: latest.contentHash,
      });
    } else {
      resolved.push(ref);
    }
  }
  return resolved;
}
