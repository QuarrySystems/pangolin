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
} from "@quarry-systems/agora-core";
import { renderPrompt } from "./prompt-renderer.js";
import { installPluginsFromManifest } from "./plugin-installer.js";
import { spawnClaude } from "./claude-spawn.js";
import { detectNeedsInputSentinel } from "./sentinel-detector.js";

export interface ClaudeCodeRuntimeAdapterOptions {
  /** Override the `claude` binary path (used by tests and exotic deploys). */
  claudeBin?: string;
}

export class ClaudeCodeRuntimeAdapter implements RuntimeAdapter {
  readonly name = "claude-code";

  readonly reservedPaths: string[] = [
    ".claude/settings.json",
    ".claude/skills/**",
    "agora-plugins.json",
  ];

  readonly mergeRules: Record<string, MergeRule> = {
    ".claude/settings.json": { strategy: "deep-merge", arrayMode: "union" },
    ".claude/skills/**": { strategy: "last-write-wins" },
    "agora-plugins.json": { strategy: "array-union" },
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
    const spawnResult = await spawnClaude({
      prompt,
      workspaceDir: spec.workspaceDir,
      env: ctx.env,
      claudeBin: this.opts.claudeBin,
    });
    const sentinelPath = await detectNeedsInputSentinel(spec.workspaceDir);

    return {
      exitCode: spawnResult.exitCode,
      stdout: spawnResult.stdout,
      stderr: spawnResult.stderr,
      needsInputSentinelPath: sentinelPath,
    };
  }
}

/** Default factory expected by the worker's adapter-loader (§5.8). */
export default function createAdapter(): RuntimeAdapter {
  return new ClaudeCodeRuntimeAdapter();
}
