// Worker→runtime env firewall (§7.7 blast-radius reduction).
//
// The worker boots with its own process.env: the Pangolin Scale control-plane vars
// (PANGOLIN_*), the ambient AWS task-role credential chain it uses to fetch
// bundles and resolve secrets, plus the usual system vars. Handing that
// wholesale to the AI runtime would let a prompt-injected sub-agent read
// the callback HMAC key reference and — worse — assume the worker's task
// role to fetch other tenants' bundles/secrets.
//
// `filterRuntimeEnv` produces the BASE env for the runtime: it removes the
// worker-internal control plane and the ambient AWS credential-vending
// variables, while preserving everything a sub-agent legitimately needs
// (PATH, HOME, locale, AWS_REGION, arbitrary user vars). Anything the
// sub-agent genuinely requires — including AWS credentials, when that is
// the deliberate intent — is supplied explicitly through an env bundle,
// which is merged ON TOP of this base (so a bundle value re-adds a stripped
// key intentionally rather than by ambient inheritance).

/** AWS credential-chain variables that vend the worker's identity. */
const AWS_CREDENTIAL_VARS: ReadonlySet<string> = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  // The container/IMDS credential endpoints — the SDK fetches the task
  // role through these. Region vars are deliberately NOT here (they are
  // config, not credentials).
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
]);

export interface FilterRuntimeEnvOpts {
  /** Extra variable names to strip beyond the built-in deny rules. */
  deny?: string[];
}

/**
 * Return a copy of `env` with worker-internal and ambient-credential
 * variables removed. A variable is stripped when it:
 *   - starts with the `PANGOLIN_` control-plane prefix, OR
 *   - is an AWS credential-vending variable (see `AWS_CREDENTIAL_VARS`), OR
 *   - is named in `opts.deny`.
 *
 * The input object is not mutated.
 */
export function filterRuntimeEnv(
  env: Record<string, string>,
  opts: FilterRuntimeEnvOpts = {},
): Record<string, string> {
  const extraDeny = new Set(opts.deny ?? []);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("PANGOLIN_")) continue;
    if (AWS_CREDENTIAL_VARS.has(key)) continue;
    if (extraDeny.has(key)) continue;
    out[key] = value;
  }
  return out;
}
