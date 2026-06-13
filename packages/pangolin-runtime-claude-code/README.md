# -systems/pangolin-runtime-claude-code

The MVP `RuntimeAdapter` implementation. Provides the Claude-Code-specific knowledge the worker delegates to: prompt rendering (Mustache substitution), invocation of the `claude --print` binary, merge rules for `.claude/settings.json` / `.claude/skills/**` / `pangolin-plugins.json`, installation of plugins from `pangolin-plugins.json`, and detection of the `needs_input` sentinel file the sub-agent writes when it wants clarification. Future runtimes (Codex, Gemini CLI, custom harnesses) implement the same `RuntimeAdapter` interface and plug into the worker the same way.

## Install

```bash
pnpm add -systems/pangolin-runtime-claude-code
```

This package is bundled into the stock worker image; integrators only depend on it directly when building custom worker images or running adapter unit tests outside a container.

## Basic usage

```typescript
import { ClaudeCodeRuntimeAdapter } from '-systems/pangolin-runtime-claude-code';

const adapter = new ClaudeCodeRuntimeAdapter();
const exit = await adapter.invoke(invocation, context);

console.log(exit.exitCode, exit.needsInputSentinelPath);
```

The worker normally constructs the adapter via `PANGOLIN_RUNTIME_ADAPTER=claude-code` and the bundled adapter-loader; direct instantiation is for tests and custom worker images. The adapter declares three `reservedPaths` (`.claude/settings.json`, `.claude/skills/**`, `pangolin-plugins.json`) that the worker's overlay engine routes through this adapter's merge rules instead of the default last-write-wins.

## Spec

- [§5.8 RuntimeAdapter](https://github.com/QuarrySystems/pangolin/blob/main/docs/superpowers/specs/2026-05-21-agora-mvp-design.md#58-runtimeadapter) — the interface this package implements.
- [§9 MVP deliverables](https://github.com/QuarrySystems/pangolin/blob/main/docs/superpowers/specs/2026-05-21-agora-mvp-design.md#9-mvp-deliverables) — the runtime-adapter smoke test that demonstrates the worker is genuinely runtime-agnostic.

## Decisions

- [ADR-0003 — Runtime adapter seam at MVP](https://quarrysystems.github.io/pangolin/explanation/decisions/0003-runtime-adapter-seam-at-mvp/): why this seam exists in v0.1 with one implementation.
- [ADR-0009 — needs_input sentinel file vs exit code](https://quarrysystems.github.io/pangolin/explanation/decisions/0009-needs-input-sentinel-file-vs-exit-code/): the signaling convention the adapter detects.
- [ADR-0011 — No entrypoint override at dispatch](https://quarrysystems.github.io/pangolin/explanation/decisions/0011-no-entrypoint-override-at-dispatch/): why the `claude --print` invocation is fixed at adapter-build time.
