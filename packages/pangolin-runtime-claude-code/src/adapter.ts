// ClaudeCodeRuntimeAdapter — concrete RuntimeAdapter for Claude Code (§5.8).
//
// Orchestrates one dispatch invocation as four sequential steps:
//   1. renderPrompt(spec)                — turn the RuntimeInvocation into text
//   2. installPluginsFromManifest(...)   — apply the post-overlay plugin manifest
//   3. spawnClaude(...)                  — run the model and capture stdio
//   4. detectNeedsInputSentinel(...)     — surface the sentinel path (ADR-0009)
//
// `reservedPaths` and `mergeRules` declare the adapter-owned slice of the
// workspace (§6.3): the runtime's overlay engine consults these so other
// adapters/overlays don't stomp on Claude-Code-managed config.
//
// `claudeBin` is injectable so the worker (and tests) can pin a specific
// binary; defaults to "claude" via the spawn helpers.

import type {
  MergeRule,
  RuntimeAdapter,
  RuntimeContext,
  RuntimeExit,
  RuntimeInvocation,
} from "@quarry-systems/pangolin-core";
import { renderPrompt } from "./prompt-renderer.js";
import { installPluginsFromManifest } from "./plugin-installer.js";
import { spawnClaude } from "./claude-spawn.js";
import { detectNeedsInputSentinel } from "./sentinel-detector.js";
import { resolveModelArg } from "./model-map.js";
import { parseClaudeEnvelope } from "./envelope.js";

export interface ClaudeCodeRuntimeAdapterOptions {
  /** Override the `claude` binary path (used by tests and exotic deploys). */
  claudeBin?: string;
}

export class ClaudeCodeRuntimeAdapter implements RuntimeAdapter {
  readonly name = "claude-code";

  readonly reservedPaths: string[] = [
    ".claude/settings.json",
    ".claude/skills/**",
    "pangolin-plugins.json",
  ];

  readonly mergeRules: Record<string, MergeRule> = {
    ".claude/settings.json": { strategy: "deep-merge", arrayMode: "union" },
    ".claude/skills/**": { strategy: "last-write-wins" },
    "pangolin-plugins.json": { strategy: "array-union" },
  };

  constructor(private readonly opts: ClaudeCodeRuntimeAdapterOptions = {}) {}

  async invoke(
    spec: RuntimeInvocation,
    ctx: RuntimeContext,
  ): Promise<RuntimeExit> {
    const prompt = renderPrompt(spec);
    await installPluginsFromManifest({
      workspaceDir: spec.workspaceDir,
      env: ctx.env,
      claudeBin: this.opts.claudeBin,
    });
    const modelArg = resolveModelArg(spec.model);
    const spawnResult = await spawnClaude({
      prompt,
      workspaceDir: spec.workspaceDir,
      env: ctx.env,
      claudeBin: this.opts.claudeBin,
      dangerouslySkipPermissions: resolveBypassFlag(ctx.env),
      model: modelArg,
    });
    const sentinelPath = await detectNeedsInputSentinel(spec.workspaceDir);
    const { text, usage } = parseClaudeEnvelope(spawnResult.stdout);

    return {
      exitCode: spawnResult.exitCode,
      stdout: text,
      stderr: spawnResult.stderr,
      needsInputSentinelPath: sentinelPath,
      ...(usage ? { usage } : {}),
    };
  }
}

/**
 * Decide whether to pass `--dangerously-skip-permissions` based on the
 * dispatch env. Read from `PANGOLIN_CLAUDE_PERMISSION_MODE`:
 *
 *   - `bypass` (DEFAULT) — pass the flag. Container-is-sandbox model: no
 *     human is in the worker, so claude's interactive permission gate would
 *     deny every tool call. The flag removes a check that is meaningless
 *     here.
 *   - `strict` — DO NOT pass the flag. Claude's default gate applies; with
 *     no approver, all tool calls are denied. Use for read-only/analytical
 *     dispatches that must do nothing destructive.
 *
 * Unrecognized values fall back to `bypass` with a warning so a typo never
 * silently leaves dispatches paralysed.
 *
 * A future `scoped` mode (allow-list in `.claude/settings.json` overlay +
 * pangolin-needs-input-helper "denied → sentinel" pattern) is tracked as a
 * follow-up.
 */
function resolveBypassFlag(env: Record<string, string>): boolean {
  const raw = env.PANGOLIN_CLAUDE_PERMISSION_MODE;
  if (raw === undefined || raw === '') return true;
  if (raw === 'bypass') return true;
  if (raw === 'strict') return false;
  // eslint-disable-next-line no-console
  console.warn(
    `claude-code adapter: unrecognized PANGOLIN_CLAUDE_PERMISSION_MODE='${raw}', falling back to 'bypass'`,
  );
  return true;
}

/** Default factory expected by the worker's adapter-loader (§5.8). */
export default function createAdapter(): RuntimeAdapter {
  return new ClaudeCodeRuntimeAdapter();
}
