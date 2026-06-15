// Worker→runtime env firewall (§7.7 blast-radius reduction) — DEFAULT-DENY.
//
// The worker boots with its own process.env: the Pangolin control-plane vars
// (PANGOLIN_*), the ambient AWS task-role credential chain it uses to fetch
// bundles and resolve secrets, plus the usual system vars. Handing that
// wholesale to the AI runtime would let a prompt-injected sub-agent read
// the callback HMAC key reference and — worse — assume the worker's task
// role to fetch other tenants' bundles/secrets.
//
// `filterRuntimeEnv` produces the BASE env for the runtime using an
// ALLOW-LIST (default-deny) model: only variables in BUILTIN_ALLOW or
// matching BUILTIN_ALLOW_PREFIXES pass through automatically. Everything
// else is dropped unless the operator explicitly adds it via
// PANGOLIN_RUNTIME_ENV_ALLOW (comma-separated exact names or PREFIX_* globs).
//
// Migration notes:
//   - Proxy vars (NODE_EXTRA_CA_CERTS, HTTP_PROXY, HTTPS_PROXY, NO_PROXY):
//     add them to PANGOLIN_RUNTIME_ENV_ALLOW if the sub-agent needs them.
//   - git is unaffected: patch-capture spawns git with the worker's own
//     unfiltered process.env, not the filtered baseEnv.
//   - Agent-needed credentials (ANTHROPIC_API_KEY etc.) already arrive via
//     env bundle / per-dispatch secret merged on top of baseEnv — they do
//     NOT need to be in BUILTIN_ALLOW.

/** Non-credential system vars always allowed into the child runtime env. */
const BUILTIN_ALLOW: ReadonlySet<string> = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL",
  "LANG", "LANGUAGE", "TZ", "TERM",
  "TMPDIR", "TMP", "TEMP", "NODE_ENV",
  "AWS_REGION", "AWS_DEFAULT_REGION",
]);
const BUILTIN_ALLOW_PREFIXES: ReadonlyArray<string> = ["LC_"];

export interface FilterRuntimeEnvOpts {
  /**
   * Operator passthrough: exact names or `PREFIX_*` trailing-glob. Empty/whitespace
   * entries are ignored. NOTE the blast radius of a bare `"*"`: it is a valid glob
   * with an empty prefix, so it matches EVERY variable and re-opens the whole
   * firewall (default-deny → default-allow). Prefer the narrowest prefix that
   * covers the deploy's vars (e.g. `MYAPP_*`) over `*`.
   */
  allow?: string[];
}

function matchesAllow(key: string, allow: ReadonlyArray<string>): boolean {
  for (const raw of allow) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    if (entry.endsWith("*")) {
      if (key.startsWith(entry.slice(0, -1))) return true;
    } else if (key === entry) {
      return true;
    }
  }
  return false;
}

export function filterRuntimeEnv(
  env: Record<string, string>,
  opts: FilterRuntimeEnvOpts = {},
): Record<string, string> {
  const allow = opts.allow ?? [];
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      BUILTIN_ALLOW.has(key) ||
      BUILTIN_ALLOW_PREFIXES.some((p) => key.startsWith(p)) ||
      matchesAllow(key, allow)
    ) {
      out[key] = value;
    }
  }
  return out;
}
