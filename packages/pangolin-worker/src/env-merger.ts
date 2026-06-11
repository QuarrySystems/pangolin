/**
 * Represents a bundle of environment variables with their values and resolved secrets.
 */
export interface EnvBundle {
  /** Plain environment variable values. */
  values: Record<string, string>;
  /** Already-resolved env-bundle secrets: envName → realValue. */
  secrets: Record<string, string>;
}

/**
 * Merges environment bundles and per-dispatch secrets into a single environment dict.
 *
 * Merge order (later wins):
 * 1. baseEnv
 * 2. envBundles (in order, both values and secrets)
 * 3. perDispatchSecrets (always wins on conflict)
 *
 * Per spec §6.2 step 6 and §4.2: per-dispatch secrets win over env-bundle secrets
 * on key conflict.
 */
export function mergeEnv(opts: {
  envBundles: EnvBundle[];
  perDispatchSecrets: Record<string, string>; // already resolved
  baseEnv: Record<string, string>; // typically PANGOLIN_* + minimal system env
}): Record<string, string> {
  let merged: Record<string, string> = { ...opts.baseEnv };

  // 1. env-bundle values + secrets, later-wins across bundles
  for (const bundle of opts.envBundles) {
    merged = { ...merged, ...bundle.values, ...bundle.secrets };
  }

  // 2. per-dispatch secrets always win
  merged = { ...merged, ...opts.perDispatchSecrets };

  return merged;
}
