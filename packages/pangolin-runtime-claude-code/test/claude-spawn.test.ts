// Tests for spawnClaude (§5.8): the runtime-cc adapter's process spawn step.
//
// The "real spawn" tests use a tiny shell stub binary so they don't depend
// on the `claude` CLI being installed. The stub is bash-based and gated off
// on Windows where `#!/bin/bash` shebangs are not honored.
//
// The "binary not found rejects" test uses a definitely-nonexistent path
// and therefore runs on every platform.
//
// `buildClaudeArgs` tests run on ALL platforms (pure arg construction, no spawn).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnClaude, buildClaudeArgs } from '../src/claude-spawn.js';

const skipOnWindows = process.platform === 'win32';

let dir: string;
let stubBin: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claude-spawn-'));
  stubBin = join(dir, 'claude-stub');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('buildClaudeArgs (platform-independent)', () => {
  it('includes --output-format json always and --model only when provided', () => {
    expect(buildClaudeArgs({ prompt: 'p', model: 'opus' })).toEqual([
      '--print',
      '--output-format',
      'json',
      '--model',
      'opus',
      'p',
    ]);
    expect(buildClaudeArgs({ prompt: 'p' })).toEqual(['--print', '--output-format', 'json', 'p']);
  });

  it('places --dangerously-skip-permissions after --output-format json and before --model', () => {
    expect(
      buildClaudeArgs({
        prompt: 'p',
        dangerouslySkipPermissions: true,
        model: 'haiku',
      }),
    ).toEqual([
      '--print',
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
      '--model',
      'haiku',
      'p',
    ]);
  });

  it('appends extraArgs after the prompt', () => {
    expect(buildClaudeArgs({ prompt: 'p', extraArgs: ['--foo', 'bar'] })).toEqual([
      '--print',
      '--output-format',
      'json',
      'p',
      '--foo',
      'bar',
    ]);
  });

  it('includes all flags together in the correct order', () => {
    expect(
      buildClaudeArgs({
        prompt: 'my-prompt',
        dangerouslySkipPermissions: true,
        model: 'sonnet',
        extraArgs: ['--extra'],
      }),
    ).toEqual([
      '--print',
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
      '--model',
      'sonnet',
      'my-prompt',
      '--extra',
    ]);
  });

  it('omits --model when model is undefined', () => {
    const args = buildClaudeArgs({ prompt: 'p', model: undefined });
    expect(args).not.toContain('--model');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
  });
});

describe('spawnClaude', () => {
  it.skipIf(skipOnWindows)('captures stdout from the spawned process', async () => {
    await writeFile(stubBin, '#!/bin/bash\necho "stub stdout"\nexit 0\n');
    await chmod(stubBin, 0o755);

    const result = await spawnClaude({
      prompt: 'hi',
      workspaceDir: dir,
      env: {},
      claudeBin: stubBin,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('stub stdout');
    expect(result.stderr).toBe('');
  });

  it.skipIf(skipOnWindows)('captures stderr from the spawned process', async () => {
    await writeFile(stubBin, '#!/bin/bash\necho "boom" 1>&2\nexit 3\n');
    await chmod(stubBin, 0o755);

    const result = await spawnClaude({
      prompt: 'hi',
      workspaceDir: dir,
      env: {},
      claudeBin: stubBin,
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('boom');
    expect(result.stdout).toBe('');
  });

  it.skipIf(skipOnWindows)(
    'invokes the binary with `--print --output-format json <prompt>` when no options are set',
    async () => {
      // Stub echoes its own argv (one arg per line) so the test can
      // assert ordering without depending on shell quoting.
      await writeFile(stubBin, '#!/bin/bash\nfor a in "$@"; do echo "$a"; done\n');
      await chmod(stubBin, 0o755);

      const result = await spawnClaude({
        prompt: 'the-rendered-prompt',
        workspaceDir: dir,
        env: {},
        claudeBin: stubBin,
      });

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.split('\n').filter((l) => l.length > 0);
      // Always includes --output-format json; no --dangerously-skip-permissions when not set.
      expect(lines).toEqual(['--print', '--output-format', 'json', 'the-rendered-prompt']);
    },
  );

  it.skipIf(skipOnWindows)(
    'inserts --dangerously-skip-permissions before the prompt when requested',
    async () => {
      await writeFile(stubBin, '#!/bin/bash\nfor a in "$@"; do echo "$a"; done\n');
      await chmod(stubBin, 0o755);

      const result = await spawnClaude({
        prompt: 'the-rendered-prompt',
        workspaceDir: dir,
        env: {},
        claudeBin: stubBin,
        dangerouslySkipPermissions: true,
      });

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.split('\n').filter((l) => l.length > 0);
      // Flag MUST precede the prompt so claude reads it as a flag, not as
      // text appended to whatever the prompt arg consumed.
      expect(lines).toEqual([
        '--print',
        '--output-format',
        'json',
        '--dangerously-skip-permissions',
        'the-rendered-prompt',
      ]);
    },
  );

  it.skipIf(skipOnWindows)('appends extraArgs after the prompt', async () => {
    await writeFile(stubBin, '#!/bin/bash\nfor a in "$@"; do echo "$a"; done\n');
    await chmod(stubBin, 0o755);

    const result = await spawnClaude({
      prompt: 'p',
      workspaceDir: dir,
      env: {},
      claudeBin: stubBin,
      extraArgs: ['--foo', 'bar'],
    });

    const lines = result.stdout.split('\n').filter((l) => l.length > 0);
    expect(lines).toEqual(['--print', '--output-format', 'json', 'p', '--foo', 'bar']);
  });

  it.skipIf(skipOnWindows)('passes --model when model option is provided', async () => {
    await writeFile(stubBin, '#!/bin/bash\nfor a in "$@"; do echo "$a"; done\n');
    await chmod(stubBin, 0o755);

    const result = await spawnClaude({
      prompt: 'p',
      workspaceDir: dir,
      env: {},
      claudeBin: stubBin,
      model: 'sonnet',
    });

    const lines = result.stdout.split('\n').filter((l) => l.length > 0);
    expect(lines).toEqual(['--print', '--output-format', 'json', '--model', 'sonnet', 'p']);
  });

  it.skipIf(skipOnWindows)('sets cwd to workspaceDir', async () => {
    await writeFile(stubBin, '#!/bin/bash\npwd\n');
    await chmod(stubBin, 0o755);

    const result = await spawnClaude({
      prompt: 'p',
      workspaceDir: dir,
      env: {},
      claudeBin: stubBin,
    });

    expect(result.exitCode).toBe(0);
    // `pwd` may resolve symlinks (e.g. /var → /private/var on macOS);
    // assert that the basename of the temp dir appears in the output.
    expect(result.stdout).toContain(dir.split(/[\\/]/).pop()!);
  });

  it.skipIf(skipOnWindows)(
    'passes the merged env to the child without inheriting from parent',
    async () => {
      // Stub prints two env vars: SPAWN_MARKER (set by caller) and
      // PARENT_ONLY (set in the test process but NOT passed in `env`).
      // The child should see SPAWN_MARKER and a literal empty for PARENT_ONLY.
      await writeFile(
        stubBin,
        '#!/bin/bash\necho "SPAWN_MARKER=$SPAWN_MARKER"\necho "PARENT_ONLY=$PARENT_ONLY"\n',
      );
      await chmod(stubBin, 0o755);

      process.env.PARENT_ONLY = 'leaked-from-parent';
      try {
        const result = await spawnClaude({
          prompt: 'p',
          workspaceDir: dir,
          env: { SPAWN_MARKER: 'from-caller', PATH: process.env.PATH ?? '' },
          claudeBin: stubBin,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('SPAWN_MARKER=from-caller');
        expect(result.stdout).toContain('PARENT_ONLY=\n');
      } finally {
        delete process.env.PARENT_ONLY;
      }
    },
  );

  it('rejects the promise when the binary cannot be spawned', async () => {
    await expect(
      spawnClaude({
        prompt: 'p',
        workspaceDir: dir,
        env: {},
        claudeBin: join(dir, 'does-not-exist-anywhere'),
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it.skipIf(skipOnWindows)(
    'captures all stdout even when output is large (stream drain test)',
    async () => {
      // Generate substantial output (many lines) to stress the stdio draining.
      // With 'exit' handler, data may be lost if streams haven't fully drained.
      // With 'close' handler, all data is guaranteed to be captured.
      const lineCount = 1000;
      const lines = Array.from({ length: lineCount }, (_, i) => `line ${i}`);
      const bashScript = `#!/bin/bash\n${lines.map((line) => `echo "${line}"`).join('\n')}\nexit 0\n`;

      await writeFile(stubBin, bashScript);
      await chmod(stubBin, 0o755);

      const result = await spawnClaude({
        prompt: 'hi',
        workspaceDir: dir,
        env: {},
        claudeBin: stubBin,
      });

      expect(result.exitCode).toBe(0);
      // Verify all lines are captured
      const outputLines = result.stdout.split('\n').filter((l) => l.length > 0);
      expect(outputLines).toHaveLength(lineCount);
      expect(result.stdout).toContain('line 0');
      expect(result.stdout).toContain(`line ${lineCount - 1}`);
    },
  );

  it.skipIf(skipOnWindows)(
    'waits for all stdio to flush before resolving (uses close, not exit)',
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
        prompt: 'hi',
        workspaceDir: dir,
        env: {},
        claudeBin: stubBin,
      });

      expect(result.exitCode).toBe(0);
      // Both lines must be present; 'exit' handler can lose "second"
      expect(result.stdout).toContain('first');
      expect(result.stdout).toContain('second');
    },
  );
});

/**
 * Timeout enforcement (KNOWN-ISSUES 9).
 *
 * `PANGOLIN_AGENT_TIMEOUT_SECONDS` was emitted by the dispatch client and read
 * by nothing, so a `timeoutSeconds` a caller passed bounded nothing worker-side.
 * `boundedAwaitExit` bounds only the `awaitExit` path, which a fire-and-forget
 * consumer never calls — for those there was no bound anywhere in the stack, and
 * on Fargate a hung agent burns billed compute until someone notices.
 *
 * A timeout is an operational failure of the child, so it RESOLVES with a
 * non-zero exit code rather than rejecting — this file's documented split
 * (reject = environment misconfiguration, resolve non-zero = the run failed).
 * 124 is the conventional timeout code, as GNU `timeout` uses.
 */
describe('spawnClaude timeout', () => {
  it.skipIf(skipOnWindows)(
    'terminates a hanging process and resolves 124 with a reason on stderr',
    async () => {
      await writeFile(stubBin, '#!/bin/bash\necho "starting"\nsleep 30\n');
      await chmod(stubBin, 0o755);

      const started = Date.now();
      const result = await spawnClaude({
        prompt: 'hi',
        workspaceDir: dir,
        env: {},
        claudeBin: stubBin,
        timeoutSeconds: 1,
      });
      const elapsed = Date.now() - started;

      expect(result.exitCode).toBe(124);
      expect(result.stderr).toMatch(/timed out after 1s/i);
      // It must actually kill, not merely stop waiting.
      expect(elapsed).toBeLessThan(15_000);
      // Output captured before the kill is preserved.
      expect(result.stdout).toContain('starting');
    },
    20_000,
  );

  it.skipIf(skipOnWindows)(
    'escalates to SIGKILL when the child ignores SIGTERM',
    async () => {
      // `trap '' TERM` makes SIGTERM a no-op, so only SIGKILL ends this.
      await writeFile(stubBin, "#!/bin/bash\ntrap '' TERM\necho ready\nsleep 30 &\nwait\n");
      await chmod(stubBin, 0o755);

      const result = await spawnClaude({
        prompt: 'hi',
        workspaceDir: dir,
        env: {},
        claudeBin: stubBin,
        timeoutSeconds: 1,
        killGraceSeconds: 1,
      });

      expect(result.exitCode).toBe(124);
      expect(result.stderr).toMatch(/SIGKILL/);
    },
    20_000,
  );

  it.skipIf(skipOnWindows)(
    'leaves a process that finishes inside the bound completely alone',
    async () => {
      await writeFile(stubBin, '#!/bin/bash\necho "quick"\nexit 0\n');
      await chmod(stubBin, 0o755);

      const result = await spawnClaude({
        prompt: 'hi',
        workspaceDir: dir,
        env: {},
        claudeBin: stubBin,
        timeoutSeconds: 30,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('quick');
      expect(result.stderr).toBe('');
    },
    20_000,
  );

  it.skipIf(skipOnWindows)(
    'preserves a non-zero exit from a process that finishes inside the bound',
    async () => {
      // The timeout path must not mask a genuine failure as a timeout.
      await writeFile(stubBin, '#!/bin/bash\necho "boom" 1>&2\nexit 3\n');
      await chmod(stubBin, 0o755);

      const result = await spawnClaude({
        prompt: 'hi',
        workspaceDir: dir,
        env: {},
        claudeBin: stubBin,
        timeoutSeconds: 30,
      });

      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain('boom');
      expect(result.stderr).not.toMatch(/timed out/i);
    },
    20_000,
  );

  it.skipIf(skipOnWindows)(
    'omitting timeoutSeconds leaves the process unbounded (unchanged behaviour)',
    async () => {
      await writeFile(stubBin, '#!/bin/bash\nsleep 0.5\necho "done"\n');
      await chmod(stubBin, 0o755);

      const result = await spawnClaude({
        prompt: 'hi',
        workspaceDir: dir,
        env: {},
        claudeBin: stubBin,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('done');
    },
    20_000,
  );
});
