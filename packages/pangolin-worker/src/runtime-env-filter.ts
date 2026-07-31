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
// NOTE the one nuance to "PANGOLIN_* is dropped": a short, explicitly-named
// set of non-credential ADAPTER CONFIG vars does pass — see
// BUILTIN_ALLOW_ADAPTER_CONFIG. Withholding those was not blast-radius
// reduction, it was a safety control silently failing open.
//
// Migration notes:
//   - Proxy vars (NODE_EXTRA_CA_CERTS, HTTP_PROXY, HTTPS_PROXY, NO_PROXY):
//     add them to PANGOLIN_RUNTIME_ENV_ALLOW if the sub-agent needs them.
//   - git does not use this filter at all: patch-capture spawns git with its
//     own fixed six-key environment (`buildGitEnv` in patch-capture.ts), which
//     is narrower than baseEnv and carries no credential of any kind.
//   - Agent-needed credentials (ANTHROPIC_API_KEY etc.) already arrive via
//     env bundle / per-dispatch secret merged on top of baseEnv — they do
//     NOT need to be in BUILTIN_ALLOW.
//   - REDACTION ASYMMETRY: values that pass this filter (built-ins and
//     operator allow-listed vars) are NOT added to the log-redaction set —
//     only env-bundle values + secret-lane values are. So never allow-list a
//     credential-bearing var here; route credentials through the secret lane
//     (env bundle / per-dispatch secret), which is both scoped and redacted.

/**
 * Non-credential ADAPTER CONFIGURATION that must reach the runtime.
 *
 * These are `PANGOLIN_*` vars, so they look like the control-plane vars this
 * filter exists to withhold — the distinction is that they carry no credential,
 * no identity and no storage location. They are how an operator configures the
 * runtime adapter, and `ctx.env` is the only channel an adapter has for
 * adapter-specific config.
 *
 * Without this, `PANGOLIN_CLAUDE_PERMISSION_MODE=strict` set on the worker was
 * silently dropped here: the claude-code adapter's `resolveBypassFlag` saw
 * nothing, fell back to `bypass`, and passed `--dangerously-skip-permissions`
 * for a dispatch the operator had asked to run with the tool-call gate ON. The
 * control failed OPEN and produced no error or warning to correlate with.
 *
 * **Extend this by EXACT NAME only — never by a `PANGOLIN_` prefix rule.**
 * `PANGOLIN_CALLBACK_TOKEN_REF` is a `PANGOLIN_` var; a prefix rule here would
 * hand the callback HMAC key reference to a prompt-injected sub-agent and
 * re-open the whole firewall. A test pins that.
 *
 * Same bar as BUILTIN_ALLOW below re: the redaction asymmetry — anything added
 * here is NOT log-redacted, so it must never carry a secret.
 */
const BUILTIN_ALLOW_ADAPTER_CONFIG: ReadonlyArray<string> = [
  'PANGOLIN_CLAUDE_PERMISSION_MODE',
  'PANGOLIN_DISABLE_NEEDS_INPUT_HELPER',
];

/** Non-credential system vars always allowed into the child runtime env. */
const BUILTIN_ALLOW: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'NODE_ENV',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  ...BUILTIN_ALLOW_ADAPTER_CONFIG,
]);
const BUILTIN_ALLOW_PREFIXES: ReadonlyArray<string> = ['LC_'];

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
    if (entry.endsWith('*')) {
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
