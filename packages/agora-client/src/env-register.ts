// `env.register(opts)` — caller-side helper for §4.1.3 and §7.1 of the
// agora-core spec.
//
// Behavior summary:
//   - Scans every entry of `opts.values` for credential-shaped patterns and
//     throws `CredentialsInEnvError` with the field
//     `env-bundle:<name>:<key>` on the first match. `opts.allowCredentialPatterns`
//     is forwarded to the scanner verbatim.
//   - Inline secrets (`{inline: ...}`) are staged via `InlineSecretStager`
//     (env-scoped, not dispatch-scoped — env bundles are reused across
//     dispatches). The resulting ref is recorded in the bundle; the inline
//     value is NEVER written to storage (§7.1 paragraph 2).
//   - Ref-form secrets (`{ref: ...}`) pass through unchanged.
//   - The content hash covers `(values, secret refs)` — never the inline
//     secret values themselves. For ref-form secrets the ref is the opaque
//     ref string itself; for inline secrets the ref is the DETERMINISTIC
//     staged-secret NAME (`${namePrefix}/env-${opts.name}/${secretKey}`),
//     NOT the AWS-returned ref. Using the deterministic name keeps the hash
//     stable across calls so the idempotency check fires BEFORE any AWS
//     staging — otherwise the second call would crash with
//     `ResourceExistsException` or get back a fresh ref that breaks hash
//     equality.
//   - If the latest registration for this logical name already matches the
//     computed content hash, the existing `EnvRef` is returned without
//     issuing a duplicate put AND without invoking the stager at all.

import {
  buildAgoraUri,
  canonicalJsonString,
  computeContentHash,
  type EnvRef,
  type SecretRef,
  type InlineSecret,
} from '@quarry-systems/agora-core';

import type { AgoraClient } from './client.js';
import {
  assertNoCredentialPattern,
  type CredentialPatternCheckOpts,
} from './credential-pattern.js';
import { InlineSecretStager } from './secrets-manager.js';

/** Options to {@link registerEnv}. */
export interface RegisterEnvOpts extends CredentialPatternCheckOpts {
  name: string;
  /**
   * Non-secret environment values (e.g. `LOG_LEVEL`, `REGION`). Each entry
   * is scanned for credential-shaped substrings; a match throws
   * `CredentialsInEnvError`.
   */
  values?: Record<string, string>;
  /**
   * Secret references. Each entry is either an already-registered opaque ref
   * (`{ref: ...}`) or an inline value (`{inline: ...}`) that will be staged
   * into Secrets Manager. The inline value never crosses into the registered
   * bundle — only the resulting ref does.
   */
  secrets?: Record<string, SecretRef | InlineSecret>;
  /**
   * Optional dependency-injected stager. Production callers should leave
   * this unset (a fresh `InlineSecretStager` is constructed on demand);
   * tests inject a fake to avoid real Secrets Manager calls.
   */
  stager?: Pick<InlineSecretStager, 'stage'>;
}

/**
 * Type guard: an entry is a ref-form secret iff it has a `ref` field.
 * The two-shape `SecretRef | InlineSecret` discriminates on this field.
 */
function isSecretRef(v: SecretRef | InlineSecret): v is SecretRef {
  return 'ref' in v;
}

/**
 * Mirrors the `InlineSecretStager`'s default `namePrefix`. Kept in sync by
 * convention — if the stager default ever changes, this must change too.
 * Tests pin this against the same default.
 */
const INLINE_SECRET_NAME_PREFIX = 'agora/inline';

/**
 * Compute the deterministic staged-secret NAME used as the hash placeholder
 * for an inline secret. Matches the name computed by
 * `InlineSecretStager.stage` when called with `dispatchId = env-${envName}`.
 *
 * The hash uses this NAME (stable across calls) rather than the AWS-returned
 * ARN (which would be fresh on every staging) so the idempotency check
 * upstream can fire before any AWS Secrets Manager call is made.
 */
function inlineSecretPlaceholder(envBundleName: string, secretKey: string): string {
  return `${INLINE_SECRET_NAME_PREFIX}/env-${envBundleName}/${secretKey}`;
}

/**
 * Register an environment bundle against the client's storage. Returns an
 * {@link EnvRef} pinning the registration's content hash.
 *
 * Throws:
 *   - `CredentialsInEnvError` when any `values:` entry matches a credential
 *     pattern (the error's `field` is `env-bundle:<name>:<key>`).
 *
 * Idempotent: re-registering with identical inputs returns the existing
 * `EnvRef` without bumping `registeredAt` or writing a new blob.
 */
export async function registerEnv(
  client: AgoraClient,
  opts: RegisterEnvOpts,
): Promise<EnvRef> {
  // 1. Scan `values:` entries for credential patterns. First match throws
  //    so the caller fixes one finding and re-runs.
  const values = opts.values ?? {};
  for (const [key, value] of Object.entries(values)) {
    assertNoCredentialPattern(`env-bundle:${opts.name}:${key}`, value, {
      allowCredentialPatterns: opts.allowCredentialPatterns,
    });
  }

  // 2. Build the *placeholder* secretRefs map — ARN-form secrets contribute
  //    their real ARN; inline secrets contribute the deterministic staged-
  //    secret NAME (NOT a real ARN yet). This map is what the content hash
  //    is computed over. Using the deterministic name keeps the hash stable
  //    across calls so the idempotency check below fires BEFORE we make
  //    any AWS Secrets Manager call.
  //
  //    The contract: the hash is a function of (values + secret IDENTITY),
  //    where "identity" is the ref for ref-form entries and the deterministic
  //    staged name for inline refs. Inline VALUES are never folded in —
  //    see §7.1 paragraph 2.
  const secrets = opts.secrets ?? {};
  const secretRefs: Record<string, string> = {};
  const inlineSecretKeys: string[] = [];
  for (const [key, entry] of Object.entries(secrets)) {
    if (isSecretRef(entry)) {
      secretRefs[key] = entry.ref;
    } else {
      secretRefs[key] = inlineSecretPlaceholder(opts.name, key);
      inlineSecretKeys.push(key);
    }
  }

  const def = {
    kind: 'env-bundle' as const,
    name: opts.name,
    values,
    secretRefs,
  };
  const contentHash = computeContentHash(def);

  const baseUri = buildAgoraUri({
    namespace: client.namespace,
    type: 'env',
    name: opts.name,
  });

  // 3. Idempotency check — if the latest registration already matches,
  //    reuse its registeredAt and skip BOTH the storage write AND any
  //    inline-secret staging. This is the load-bearing reordering: staging
  //    before this check would crash on the second identical call
  //    (`ResourceExistsException`) or hand back a fresh ARN that breaks
  //    hash equality.
  const latest = await client.storage.resolveLatest(baseUri);
  if (latest && latest.contentHash === contentHash) {
    return {
      name: opts.name,
      registeredAt: latest.registeredAt,
      contentHash,
    };
  }

  // 4. Not idempotent — this is a fresh registration. Now (and only now)
  //    stage the inline secrets to obtain real ARNs. The stored bundle
  //    blob contains the real ARNs (so the runtime can mount them); only
  //    the contentHash itself was computed from the placeholder names.
  if (inlineSecretKeys.length > 0) {
    const stager = opts.stager ?? new InlineSecretStager();
    for (const key of inlineSecretKeys) {
      const entry = secrets[key] as InlineSecret;
      const { arn } = await stager.stage({
        // Env-bundle secrets are not dispatch-scoped — use the env name
        // as the disambiguator. This MUST stay aligned with
        // `inlineSecretPlaceholder` so the stager's computed name matches
        // the placeholder folded into the hash above.
        dispatchId: `env-${opts.name}`,
        envName: key,
        inline: entry,
        // Envs aren't dispatch-scoped; the stager's auto-TTL formula
        // falls back to (7200 + 300) = 7500s per §7.6 until §7.6's
        // explicit per-dispatch override is introduced elsewhere.
      });
      secretRefs[key] = arn;
    }
  }

  // 5. Write the bundle payload at the pinned URI. The pinned URI uses
  //    the placeholder-derived contentHash (stable across calls); the
  //    blob body carries the real ARNs.
  const pinnedUri = buildAgoraUri({
    namespace: client.namespace,
    type: 'env',
    name: opts.name,
    contentHash,
  });
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
  const after = await client.storage.resolveLatest(baseUri);
  const registeredAt = after?.registeredAt ?? new Date().toISOString();
  return { name: opts.name, registeredAt, contentHash };
}
