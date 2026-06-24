import { describe, it, expect } from 'vitest';
import { runBoundedCommand } from '../src/bounded-command.js';

// Process-spawning tests require a POSIX shell. Skip on Windows.
const itPosix = process.platform === 'win32' ? it.skip : it;

describe('runBoundedCommand', () => {
  itPosix('captures stdout and stderr, returns exitCode 0', async () => {
    const result = await runBoundedCommand({
      command: "sh -c 'echo out; echo err >&2'",
      cwd: process.cwd(),
      env: {},
      timeoutSeconds: 5,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('out');
    expect(result.stderr).toContain('err');
    expect(result.timedOut).toBe(false);
    expect(result.startError).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  itPosix('returns non-zero exitCode on failure', async () => {
    const result = await runBoundedCommand({
      command: "sh -c 'exit 42'",
      cwd: process.cwd(),
      env: {},
      timeoutSeconds: 5,
    });
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });

  itPosix('respects maxOutputChars cap', async () => {
    const result = await runBoundedCommand({
      command: "sh -c 'printf '%0.s1234567890' {1..100}'",
      cwd: process.cwd(),
      env: {},
      timeoutSeconds: 5,
      maxOutputChars: 20,
    });
    expect(result.stdout.length).toBeLessThanOrEqual(20);
  });

  itPosix('sets timedOut=true and exitCode=-1 when process exceeds timeout', async () => {
    const result = await runBoundedCommand({
      command: "sh -c 'sleep 60'",
      cwd: process.cwd(),
      env: {},
      timeoutSeconds: 1,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
  });

  it('sets startError when command cannot be found', async () => {
    const result = await runBoundedCommand({
      command: '__no_such_command__',
      args: [],
      cwd: process.cwd(),
      env: {},
      timeoutSeconds: 5,
    });
    expect(result.startError).toBeInstanceOf(Error);
    expect(result.exitCode).toBe(-1);
    expect(result.timedOut).toBe(false);
  });
});
