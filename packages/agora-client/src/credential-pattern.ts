// Credential-shape detector (§7.1).
//
// Used by `env.register()` to validate `values:` entries and by
// `capabilities.register()` to validate file contents. Throws
// `CredentialsInEnvError` on the first matching pattern so callers fix one
// finding and re-run.

import { CredentialsInEnvError } from "@quarry-systems/agora-core";

/** Patterns that indicate credential-shaped strings (§7.1). */
const CREDENTIAL_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "aws-session-key", regex: /\bASIA[0-9A-Z]{16}\b/ },
  {
    name: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  { name: "bearer-prefix", regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/ },
  { name: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{36}\b/ },
  // Anthropic keys (`sk-ant-...`) MUST precede the generic OpenAI `sk-`
  // pattern so the more specific name is reported first. The two are
  // disjoint anyway — Anthropic keys carry hyphens that break OpenAI's
  // all-alphanumeric run — but ordering keeps the `detail` precise.
  { name: "anthropic-key", regex: /\bsk-ant-[A-Za-z0-9-]{16,}/ },
  { name: "openai-key", regex: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "google-api-key", regex: /\bAIza[A-Za-z0-9_-]{35}\b/ },
  { name: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "stripe-key", regex: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  // PEM private-key armor. The first 16 chars folded into the error are
  // just the header (`-----BEGIN RSA P`), never key material.
  { name: "private-key", regex: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/ },
];

export interface CredentialPatternCheckOpts {
  /**
   * Named patterns to skip (false-positive opt-out). Names correspond to the
   * `name` field of each entry in `CREDENTIAL_PATTERNS` — e.g.
   * `"aws-access-key"`, `"jwt"`.
   */
  allowCredentialPatterns?: string[];
}

/**
 * Scan a string for credential-shaped substrings. Throws
 * `CredentialsInEnvError` on the FIRST matching pattern (callers fix one and
 * re-run). The `field` argument is folded into the error for caller-side
 * debugging — e.g. `"env-bundle:prod:GH_TOKEN"` or
 * `"capability:git-write:.claude/settings.json"`.
 *
 * The error `detail` contains the named pattern that matched and the first
 * 16 chars of the matched substring (truncated to avoid leaking the full
 * credential into logs).
 */
export function assertNoCredentialPattern(
  field: string,
  value: string,
  opts: CredentialPatternCheckOpts = {},
): void {
  const skip = new Set(opts.allowCredentialPatterns ?? []);
  for (const { name, regex } of CREDENTIAL_PATTERNS) {
    if (skip.has(name)) continue;
    const match = regex.exec(value);
    if (match) {
      throw new CredentialsInEnvError(
        field,
        `${name} pattern matched: ${match[0].slice(0, 16)}...`,
      );
    }
  }
}
