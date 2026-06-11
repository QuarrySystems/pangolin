// Tests for the ClaudeCodeRuntimeAdapter (§5.8): the top-level class that
// composes prompt-render → plugin-install → claude-spawn → sentinel-detect.
//
// Shape tests (class name, reservedPaths, mergeRules, factory export) run
// on every platform; the integration test that exercises `invoke()` relies
// on a bash-stub binary and is gated off on Windows.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeAdapter } from "@quarry-systems/pangolin-core";
import createAdapter, {
  ClaudeCodeRuntimeAdapter,
} from "../src/adapter.js";

const skipOnWindows = process.platform === "win32";

describe("ClaudeCodeRuntimeAdapter — static shape", () => {
  it("exports a ClaudeCodeRuntimeAdapter class", () => {
    const a = new ClaudeCodeRuntimeAdapter();
    expect(a).toBeInstanceOf(ClaudeCodeRuntimeAdapter);
  });

  it("default export is a no-arg factory returning a ClaudeCodeRuntimeAdapter", () => {
    const a = createAdapter();
    expect(a).toBeInstanceOf(ClaudeCodeRuntimeAdapter);
  });

  it("name is 'claude-code'", () => {
    const a = new ClaudeCodeRuntimeAdapter();
    expect(a.name).toBe("claude-code");
  });

  it("reservedPaths matches §5.8 exactly", () => {
    const a = new ClaudeCodeRuntimeAdapter();
    expect(a.reservedPaths).toEqual([
      ".claude/settings.json",
      ".claude/skills/**",
      "pangolin-plugins.json",
    ]);
  });

  it("mergeRules['.claude/settings.json'] is deep-merge with arrayMode union", () => {
    const a = new ClaudeCodeRuntimeAdapter();
    expect(a.mergeRules?.[".claude/settings.json"]).toEqual({
      strategy: "deep-merge",
      arrayMode: "union",
    });
  });

  it("mergeRules['.claude/skills/**'] is last-write-wins", () => {
    const a = new ClaudeCodeRuntimeAdapter();
    expect(a.mergeRules?.[".claude/skills/**"]).toEqual({
      strategy: "last-write-wins",
    });
  });

  it("mergeRules['pangolin-plugins.json'] is array-union", () => {
    const a = new ClaudeCodeRuntimeAdapter();
    expect(a.mergeRules?.["pangolin-plugins.json"]).toEqual({
      strategy: "array-union",
    });
  });

  it("is assignable to RuntimeAdapter (structural typecheck)", () => {
    const a: RuntimeAdapter = new ClaudeCodeRuntimeAdapter();
    expect(typeof a.invoke).toBe("function");
  });
});

describe("ClaudeCodeRuntimeAdapter — invoke()", () => {
  let dir: string;
  let stubBin: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "adapter-"));
    stubBin = join(dir, "claude-stub");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(skipOnWindows)(
    "composes render → spawn → sentinel-detect and returns RuntimeExit",
    async () => {
      await writeFile(
        stubBin,
        '#!/bin/bash\necho "stub-stdout"\necho "stub-stderr" 1>&2\nexit 0\n',
      );
      await chmod(stubBin, 0o755);

      const adapter = new ClaudeCodeRuntimeAdapter({ claudeBin: stubBin });
      const exit = await adapter.invoke(
        { systemPrompt: "hello", workspaceDir: dir },
        { dispatchId: "d1", env: { PATH: process.env.PATH ?? "" } },
      );

      expect(exit.exitCode).toBe(0);
      expect(exit.stdout).toContain("stub-stdout");
      expect(exit.stderr).toContain("stub-stderr");
      // No `.pangolin/needs_input.json` in the fresh tmp workspace.
      expect(exit.needsInputSentinelPath).toBeUndefined();
    },
  );

  it.skipIf(skipOnWindows)(
    "propagates a non-zero spawn exit code",
    async () => {
      await writeFile(stubBin, "#!/bin/bash\nexit 7\n");
      await chmod(stubBin, 0o755);

      const adapter = new ClaudeCodeRuntimeAdapter({ claudeBin: stubBin });
      const exit = await adapter.invoke(
        { systemPrompt: "p", workspaceDir: dir },
        { dispatchId: "d2", env: { PATH: process.env.PATH ?? "" } },
      );

      expect(exit.exitCode).toBe(7);
    },
  );

  it.skipIf(skipOnWindows)(
    "returns needsInputSentinelPath when .pangolin/needs_input.json exists",
    async () => {
      await writeFile(stubBin, "#!/bin/bash\nexit 0\n");
      await chmod(stubBin, 0o755);

      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, ".pangolin"), { recursive: true });
      await writeFile(
        join(dir, ".pangolin", "needs_input.json"),
        '{"question":"?"}',
      );

      const adapter = new ClaudeCodeRuntimeAdapter({ claudeBin: stubBin });
      const exit = await adapter.invoke(
        { systemPrompt: "p", workspaceDir: dir },
        { dispatchId: "d3", env: { PATH: process.env.PATH ?? "" } },
      );

      expect(exit.needsInputSentinelPath).toBe(
        join(dir, ".pangolin", "needs_input.json"),
      );
    },
  );

  it.skipIf(skipOnWindows)(
    "renders promptTemplate with input and forwards the rendered text as --print arg",
    async () => {
      // Echo argv so we can assert the prompt actually flowed through render.
      await writeFile(
        stubBin,
        '#!/bin/bash\nfor a in "$@"; do echo "$a"; done\n',
      );
      await chmod(stubBin, 0o755);

      const adapter = new ClaudeCodeRuntimeAdapter({ claudeBin: stubBin });
      const exit = await adapter.invoke(
        {
          promptTemplate: "hi {{name}}",
          input: { name: "world" },
          workspaceDir: dir,
        },
        { dispatchId: "d4", env: { PATH: process.env.PATH ?? "" } },
      );

      expect(exit.exitCode).toBe(0);
      const lines = exit.stdout.split("\n").filter((l) => l.length > 0);
      expect(lines[0]).toBe("--print");
      expect(lines[1]).toBe("--output-format");
      expect(lines[2]).toBe("json");
      expect(lines[3]).toBe("--dangerously-skip-permissions");
      expect(lines[4]).toBe("hi world");
    },
  );

  it.skipIf(skipOnWindows)(
    "PANGOLIN_CLAUDE_PERMISSION_MODE=strict drops --dangerously-skip-permissions",
    async () => {
      await writeFile(
        stubBin,
        '#!/bin/bash\nfor a in "$@"; do echo "$a"; done\n',
      );
      await chmod(stubBin, 0o755);

      const adapter = new ClaudeCodeRuntimeAdapter({ claudeBin: stubBin });
      const exit = await adapter.invoke(
        { systemPrompt: "do nothing", workspaceDir: dir },
        {
          dispatchId: "d-strict",
          env: {
            PATH: process.env.PATH ?? "",
            PANGOLIN_CLAUDE_PERMISSION_MODE: "strict",
          },
        },
      );

      expect(exit.exitCode).toBe(0);
      const lines = exit.stdout.split("\n").filter((l) => l.length > 0);
      expect(lines).not.toContain("--dangerously-skip-permissions");
      expect(lines[0]).toBe("--print");
    },
  );

  it.skipIf(skipOnWindows)(
    "unrecognized PANGOLIN_CLAUDE_PERMISSION_MODE warns and falls back to bypass",
    async () => {
      await writeFile(
        stubBin,
        '#!/bin/bash\nfor a in "$@"; do echo "$a"; done\n',
      );
      await chmod(stubBin, 0o755);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const adapter = new ClaudeCodeRuntimeAdapter({ claudeBin: stubBin });
        const exit = await adapter.invoke(
          { systemPrompt: "anything", workspaceDir: dir },
          {
            dispatchId: "d-typo",
            env: {
              PATH: process.env.PATH ?? "",
              PANGOLIN_CLAUDE_PERMISSION_MODE: "bypaaass",
            },
          },
        );

        expect(exit.exitCode).toBe(0);
        const lines = exit.stdout.split("\n").filter((l) => l.length > 0);
        expect(lines).toContain("--dangerously-skip-permissions");
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringMatching(/unrecognized PANGOLIN_CLAUDE_PERMISSION_MODE/),
        );
      } finally {
        warnSpy.mockRestore();
      }
    },
  );
});
