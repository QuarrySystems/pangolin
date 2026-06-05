// Sync-provider contract.
//
// A provider knows how to enumerate one external tool's on-disk convention
// (Claude Code agents/skills, Cursor rules, etc.) as agora-native shapes.
// Providers are pure data adapters: they read filesystem, they do NOT call
// the AgoraClient or do registration. The cmd-* files orchestrate by taking
// provider output and feeding it to client.subagent.register() /
// client.capabilities.register().
//
// This split keeps:
//   - Commander wiring + registration UX in cmd-* files (one concern)
//   - Provider-specific filesystem layout knowledge in providers/* (one
//     concern per provider)
//   - The shared frontmatter helper in src/frontmatter.ts (one concern)
// and makes adding a second provider a single new file under providers/.

import type { VerifyConfig } from '@quarry-systems/agora-client';

export interface SubagentDef {
  name: string;
  systemPrompt?: string;
  promptTemplate?: string;
  model?: string;
  capabilities?: string[];
  /**
   * Optional self-verify command (Gap A) — a language-agnostic shell command
   * (`dotnet test`, `cargo test`, `pytest`, `tsc && vitest`, …) the worker
   * runs over its edit, sealing pass/fail into the output sentinel.
   */
  verify?: VerifyConfig;
}

export interface CapabilityBundle {
  name: string;
  files: Record<string, Uint8Array>;
}

export interface SyncProvider {
  /** Identifier used in the `--provider` flag. */
  readonly name: string;
  /** Default directory under cwd where this provider's subagents live. */
  readonly defaultSubagentDir: string;
  /** Default directory under cwd where this provider's capabilities live. */
  readonly defaultCapabilityDir: string;
  /** Enumerate subagent definitions from `dir`. */
  loadSubagents(dir: string): Promise<SubagentDef[]>;
  /** Enumerate capability bundles from `dir`. */
  loadCapabilities(dir: string): Promise<CapabilityBundle[]>;
}
