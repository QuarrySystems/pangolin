/**
 * TTL computation for staged inline secrets per §7.6.
 *
 * Extracted from secrets-manager.ts so other modules can import this
 * helper without pulling in InlineSecretStager.
 */

/**
 * Compute the TTL for a staged inline secret per §7.6.
 *
 * Precedence:
 *   1. `explicit` (the caller-supplied `InlineSecret.ttlSeconds`) wins if set.
 *   2. Otherwise: `(dispatchTimeoutSeconds ?? 7200) + 300`.
 *
 * `explicit: 0` is honored as a deliberate zero TTL — callers that want the
 * auto-formula should omit the field rather than pass 0.
 */
export function computeInlineSecretTtl(opts: {
  explicit?: number;
  dispatchTimeoutSeconds?: number;
}): number {
  if (opts.explicit !== undefined) return opts.explicit;
  return (opts.dispatchTimeoutSeconds ?? 7200) + 300;
}
