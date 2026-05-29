// Tests for spawnClaude (§5.8): the runtime-cc adapter's process spawn step.
//
// The "real spawn" tests use a tiny shell stub binary so they don't depend
// on the `claude` CLI being installed. The stub is bash-based and gated off
// on Windows where `#!/bin/bash` shebangs are not honored.
//
// The "binary not found rejects" test uses a definitely-nonexistent path
// and therefore runs on every platform.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnClaude } from "../src/claude-spawn.js";

const skipOnWindows = process.platform === "win32";

let dir: string;
let stubBin: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claude-spawn-"));
  stubBin = join(dir, "claude-stub");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("spawnClaude", () => {
  it.skipIf(skipOnWindows)(
    "captures stdout from the spawned process",
    async () => {
      await writeFile(
        stubBin,
        '#!/bin/bash\necho "stub stdout"\nexit 0\n',
      );
      await chmod(stubBin, 0o755);

      const result = await spawnClaude({
        prompt: "hi",
        workspaceDir: dir,
        env: {},
        claudeBin: stubBin,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("stub stdout");
      expect(result.stderr).toBe("");
    },
  );

  it.skipIf(skipOnWindows)(
    "captures stderr from the spawned process",
    async () => {
      await writeFile(
        stubBin,
        '#!/bin/bash\necho "boom" 1>&2\nexit 3\n',
      );
      await chmod(stubBin, 0o755);

      const result = await spawnClaude({
        prompt: "hi",
        workspaceDir: dir,
        env: {},
        claudeBin: stubBin,
      });

      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("boom");
      expect(result.stdout).toBe("");
    },
  );

  it.skipIf(skipOnWindows)(
    "invokes the binary with `--print <prompt>` when dangerouslySkipPermissions is unset",
    async () => {
      // Stub echoes its own argv (one arg per line) so the test can
      // assert ordering without depending on shell quoting.
      await writeFile(
        stubBin,
        '#!/bin/bash\nfor a in "$@"; do echo "$a"; done\n',
      );
      await chmod(stubBin, 0o755);

      const result = await spawnClaude({
        prompt: "the-rendered-prompt",
        workspaceDir: dir,
        env: {},
        claudeBin: stubBin,
      });

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.split("\n").filter((l) => l.length > 0);
      // Spawn is policy-free: it only emits the flag when the caller
      // asked for it. The adapter resolves the policy from env.
      expect(lines).toEqual(["--print", "the-rendered-prompt"]);
    },
  );

  it.skipIf(skipOnWindows)(
    "inserts --dangerously-skip-permissions before the prompt when requested",
    async () => {
      await writeFile(
        stubBin,
        '#!/bin/bash\nfor a in "$@"; do echo "$a"; done\n',
      );
      await chmod(stubBin, 0o755);

      const result = await spawnClaude({
        prompt: "the-rendered-prompt",
        workspaceDir: dir,
        env: {},
        claudeBin: stubBin,
        dangerouslySkipPermissions: true,
      });

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.split("\n").filter((l) => l.length > 0);
      // Flag MUST precede the prompt so claude reads it as a flag, not as
      // text appended to whatever the prompt arg consumed.
      expect(lines).toEqual([
        "--print",
        "--dangerously-skip-permissions",
        "the-rendered-prompt",
      ]);
    },
  );

  it.skipIf(skipOnWindows)(
    "appends extraArgs after the prompt",
    async () => {
      await writeFile(
        stubBin,
        '#!/bin/bash\nfor a in "$@"; do echo "$a"; done\n',
      );
      await chmod(stubBin, 0o755);

      const result = await spawnClaude({
        prompt: "p",
        workspaceDir: dir,
        env: {},
        claudeBin: stubBin,
        extraArgs: ["--model", "sonnet"],
      });

      const lines = result.stdout.split("\n").filter((l) => l.length > 0);
      expect(lines).toEqual(["--print", "p", "--model", "sonnet"]);
    },
  );

  it.skipIf(skipOnWindows)(
    "sets cwd to workspaceDir",
    async () => {
      await writeFile(stubBin, "#!/bin/bash\npwd\n");
      await chmod(stubBin, 0o755);

      const result = await spawnClaude({
        prompt: "p",
        workspaceDir: dir,
        env: {},
        claudeBin: stubBin,
      });

      expect(result.exitCode).toBe(0);
      // `pwd` may resolve symlinks (e.g. /var → /private/var on macOS);
      // assert that the basename of the temp dir appears in the output.
      expect(result.stdout).toContain(dir.split(/[\\/]/).pop()!);
    },
  );

  it.skipIf(skipOnWindows)(
    "passes the merged env to the child without inheriting from parent",
    async () => {
      // Stub prints two env vars: SPAWN_MARKER (set by caller) and
      // PARENT_ONLY (set in the test process but NOT passed in `env`).
      // The child should see SPAWN_MARKER and a literal empty for PARENT_ONLY.
      await writeFile(
        stubBin,
        '#!/bin/bash\necho "SPAWN_MARKER=$SPAWN_MARKER"\necho "PARENT_ONLY=$PARENT_ONLY"\n',
      );
      await chmod(stubBin, 0o755);

      process.env.PARENT_ONLY = "leaked-from-parent";
      try {
        const result = await spawnClaude({
          prompt: "p",
          workspaceDir: dir,
          env: { SPAWN_MARKER: "from-caller", PATH: process.env.PATH ?? "" },
          claudeBin: stubBin,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("SPAWN_MARKER=from-caller");
        expect(result.stdout).toContain("PARENT_ONLY=\n");
      } finally {
        delete process.env.PARENT_ONLY;
      }
    },
  );

  it("rejects the promise when the binary cannot be spawned", async () => {
    await expect(
      spawnClaude({
        prompt: "p",
        workspaceDir: dir,
        env: {},
        claudeBin: join(dir, "does-not-exist-anywhere"),
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it.skipIf(skipOnWindows)(
    "captures all stdout even when output is large (stream drain test)",
    async () => {
      // Generate substantial output (many lines) to stress the stdio draining.
      // With 'exit' handler, data may be lost if streams haven't fully drained.
      // With 'close' handler, all data is guaranteed to be captured.
      const lineCount = 1000;
      const lines = Array.from({ length: lineCount }, (_, i) => `line ${i}`);
      const bashScript = `#!/bin/bash\n${lines.map((line) => `echo "${line}"`).join("\n")}\nexit 0\n`;

      await writeFile(stubBin, bashScript);
      await chmod(stubBin, 0o755);

      const result = await spawnClaude({
        prompt: "hi",
        workspaceDir: dir,
        env: {},
        claudeBin: stubBin,
      });

      expect(result.exitCode).toBe(0);
      // Verify all lines are captured
      const outputLines = result.stdout.split("\n").filter((l) => l.length > 0);
      expect(outputLines).toHaveLength(lineCount);
      expect(result.stdout).toContain("line 0");
      expect(result.stdout).toContain(`line ${lineCount - 1}`);
    },
  );

  it.skipIf(skipOnWindows)(
    "waits for all stdio to flush before resolving (uses close, not exit)",
    async () => {
      // This test reproduces the issue: 'exit' fires when process terminates
      // but streams may still be draining. 'close' fires only after all stdio
      // is fully flushed. We emit data on a small delay to ensure the streams
      // aren't empty when the process exits.
      await writeFile(
        stubBin,
        '#!/bin/bash\n(echo "first"; sleep 0.1; echo "second") &\nwait\nexit 0\n',
      );
      await chmod(stubBin, 0o755);

      const result = await spawnClaude({
        prompt: "hi",
        workspaceDir: dir,
        env: {},
        claudeBin: stubBin,
      });

      expect(result.exitCode).toBe(0);
      // Both lines must be present; 'exit' handler can lose "second"
      expect(result.stdout).toContain("first");
      expect(result.stdout).toContain("second");
    },
  );
});
