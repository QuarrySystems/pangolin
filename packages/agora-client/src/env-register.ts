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
//     dispatches). The resulting ARN is recorded in the bundle; the inline
//     value is NEVER written to storage (§7.1 paragraph 2).
//   - ARN-form secrets (`{arn: ...}`) pass through unchanged.
//   - The content hash covers `(values, secret-ARN refs)` — never the inline
//     secret values themselves. This guarantees that re-issuing the same
//     env bundle with a rotated inline secret value produces a different
//     content hash iff the resulting ARN differs.
//   - If the latest registration for this logical name already matches the
//     computed content hash, the existing `EnvRef` is returned without
//     issuing a duplicate put (idempotent).

import {
  buildAgoraUri,
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
   * Secret references. Each entry is either an already-registered ARN
   * (`{arn: ...}`) or an inline value (`{inline: ...}`) that will be staged
   * into Secrets Manager. The inline value never crosses into the registered
   * bundle — only the resulting ARN does.
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
 * Type guard: an entry is an ARN-form secret iff it has an `arn` field.
 * The two-shape `SecretRef | InlineSecret` discriminates on this field.
 */
function isSecretRef(v: SecretRef | InlineSecret): v is SecretRef {
  return 'arn' in v;
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

  // 2. Resolve every secret to an ARN. Inline secrets are staged via the
  //    InlineSecretStager (env-scoped — the disambiguator is the env name,
  //    not a dispatch id, because env bundles are reused across dispatches).
  //    ARN-form secrets pass through unchanged.
  const secrets = opts.secrets ?? {};
  const secretRefs: Record<string, string> = {};
  if (Object.keys(secrets).length > 0) {
    const stager = opts.stager ?? new InlineSecretStager();
    for (const [key, entry] of Object.entries(secrets)) {
      if (isSecretRef(entry)) {
        secretRefs[key] = entry.arn;
      } else {
        const { arn } = await stager.stage({
          // Env-bundle secrets are not dispatch-scoped — use the env name
          // as the disambiguator so the same inline value re-registered for
          // the same env collapses to one stage call per registration.
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
  }

  // 3. Compute the content hash over (values + secret ARN refs). Inline
  //    secret VALUES are never folded in — see §7.1 paragraph 2.
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

  // 4. Idempotency check — if the latest registration already matches,
  //    reuse its registeredAt and skip the storage write.
  const latest = await client.storage.resolveLatest(baseUri);
  if (latest && latest.contentHash === contentHash) {
    return {
      name: opts.name,
      registeredAt: latest.registeredAt,
      contentHash,
    };
  }

  // 5. Otherwise, write the bundle payload at the pinned URI.
  const pinnedUri = buildAgoraUri({
    namespace: client.namespace,
    type: 'env',
    name: opts.name,
    contentHash,
  });
  await client.storage.put(
    pinnedUri,
    new TextEncoder().encode(JSON.stringify(def)),
  );

  // The storage layer is the authority on registeredAt — re-read it.
  const after = await client.storage.resolveLatest(baseUri);
  const registeredAt = after?.registeredAt ?? new Date().toISOString();
  return { name: opts.name, registeredAt, contentHash };
}
