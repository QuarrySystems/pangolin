import type { InlineSecret } from './refs.js';

/** Which Anthropic credential the worker's `claude` CLI authenticates with. */
export type ClaudeAuthMode = 'api-key' | 'subscription';

export interface ClaudeAuthSecrets {
  /** The credential lane chosen for this dispatch. */
  mode: ClaudeAuthMode;
  /** The single env var staged: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. */
  credentialName: string;
  /** Whether the chosen credential has a non-empty value (false on an import-safe empty load). */
  present: boolean;
  /** Per-dispatch secrets map to pass straight to `DispatchExecutor`'s `secrets`. */
  secrets: Record<string, InlineSecret>;
}

/**
 * Build the per-dispatch Claude credential secret from an environment.
 *
 * The worker's `claude` CLI reads its Anthropic credential from its env. Two
 * mutually-exclusive lanes are supported:
 *
 *  - `subscription` — a Claude Pro/Max OAuth token in `CLAUDE_CODE_OAUTH_TOKEN`
 *    (minted by `claude setup-token`). Bills the user's subscription; no API credits.
 *  - `api-key` — an `ANTHROPIC_API_KEY`. Bills the API organization per-token.
 *
 * EXACTLY ONE credential is staged. The CLI's auth precedence puts
 * `ANTHROPIC_API_KEY` ABOVE `CLAUDE_CODE_OAUTH_TOKEN`, so staging both would
 * silently fall back to the API key and defeat the subscription. This helper
 * therefore never emits both — it is the single seam that guarantees that.
 *
 * Selection:
 *  1. `PANGOLIN_CLAUDE_AUTH` forces the lane explicitly (`subscription` | `api-key`).
 *  2. Otherwise auto: a non-empty OAuth token → `subscription`; else `api-key`.
 *
 * Mirrors the existing config posture: the chosen credential may be empty (e.g.
 * an import-safe `pangolin.config.mjs` load with nothing set) — callers gate the
 * live run on `present` exactly as they gate on a non-empty key today.
 */
export function claudeAuthSecrets(
  env: Record<string, string | undefined> = process.env,
): ClaudeAuthSecrets {
  const override = env.PANGOLIN_CLAUDE_AUTH;
  const oauth = env.CLAUDE_CODE_OAUTH_TOKEN ?? '';
  const apiKey = env.ANTHROPIC_API_KEY ?? '';

  let mode: ClaudeAuthMode;
  if (override === undefined || override === '') {
    mode = oauth !== '' ? 'subscription' : 'api-key';
  } else if (override === 'subscription' || override === 'api-key') {
    mode = override;
  } else {
    throw new Error(
      `PANGOLIN_CLAUDE_AUTH must be 'subscription' or 'api-key', got: ${override}`,
    );
  }

  if (mode === 'subscription') {
    return {
      mode,
      credentialName: 'CLAUDE_CODE_OAUTH_TOKEN',
      present: oauth !== '',
      secrets: { CLAUDE_CODE_OAUTH_TOKEN: { inline: oauth } },
    };
  }
  return {
    mode,
    credentialName: 'ANTHROPIC_API_KEY',
    present: apiKey !== '',
    secrets: { ANTHROPIC_API_KEY: { inline: apiKey } },
  };
}
