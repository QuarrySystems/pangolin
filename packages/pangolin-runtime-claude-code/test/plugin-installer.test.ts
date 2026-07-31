import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

// Mock node:child_process so tests don't depend on the `claude` CLI being
// installed. The mock factory must be self-contained (no closures over
// test-scope vars) due to vitest hoisting.
vi.mock('node:child_process', () => {
  const calls: Array<{
    bin: string;
    args: string[];
    stdio: unknown;
    cwd?: string;
    env?: Record<string, string>;
  }> = [];
  // `hang` makes the child never emit 'close' on its own, so a timeout is the
  // only thing that can end it; `signals` records what the code under test
  // sent, which is how SIGTERM→SIGKILL escalation is asserted.
  const config = {
    nextExitCode: 0,
    nextStdout: '',
    nextStderr: '',
    hang: false,
    ignoreTerm: false,
  };
  const signals: string[] = [];
  function spawn(
    bin: string,
    args: string[],
    opts: { stdio?: unknown; cwd?: string; env?: Record<string, string> } = {},
  ) {
    calls.push({ bin, args, stdio: opts.stdio, cwd: opts.cwd, env: opts.env });
    const ee = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: (signal?: string) => boolean;
    };
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    ee.kill = (signal = 'SIGTERM') => {
      signals.push(signal);
      // A child that ignores SIGTERM dies only on SIGKILL — the escalation case.
      if (signal === 'SIGKILL' || !config.ignoreTerm) {
        setImmediate(() => ee.emit('close', null));
      }
      return true;
    };
    setImmediate(() => {
      if (config.nextStdout) ee.stdout.emit('data', Buffer.from(config.nextStdout));
      if (config.nextStderr) ee.stderr.emit('data', Buffer.from(config.nextStderr));
      if (!config.hang) ee.emit('close', config.nextExitCode);
    });
    return ee;
  }
  return {
    spawn,
    // Test-only escape hatches exposed on the mock module.
    __calls: calls,
    __config: config,
    __signals: signals,
    __reset: () => {
      calls.length = 0;
      signals.length = 0;
      Object.assign(config, {
        nextExitCode: 0,
        nextStdout: '',
        nextStderr: '',
        hang: false,
        ignoreTerm: false,
      });
    },
  };
});

import { installPluginsFromManifest } from '../src/plugin-installer.js';
import * as cp from 'node:child_process';

type MockCpModule = typeof cp & {
  __calls: Array<{
    bin: string;
    args: ReadonlyArray<string>;
    stdio: unknown;
    cwd?: string;
    env?: Record<string, string>;
  }>;
  __config: {
    nextExitCode: number;
    nextStdout: string;
    nextStderr: string;
    hang: boolean;
    ignoreTerm: boolean;
  };
  __signals: string[];
  __reset: () => void;
};

const cpMock = cp as unknown as MockCpModule;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plugins-'));
  cpMock.__reset();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('installPluginsFromManifest', () => {
  it('is a no-op when pangolin-plugins.json is absent', async () => {
    await expect(
      installPluginsFromManifest({ workspaceDir: dir, env: {} }),
    ).resolves.toBeUndefined();
    expect(cpMock.__calls).toHaveLength(0);
  });

  it('invokes `claude plugins install <name>` for each entry in declared order', async () => {
    await writeFile(
      join(dir, 'pangolin-plugins.json'),
      JSON.stringify(['alpha', 'beta', 'gamma']),
      'utf8',
    );

    await installPluginsFromManifest({
      workspaceDir: dir,
      env: { FOO: 'bar' },
    });

    expect(cpMock.__calls).toHaveLength(3);
    expect(cpMock.__calls[0]).toMatchObject({
      bin: 'claude',
      args: ['plugins', 'install', 'alpha'],
      cwd: dir,
      env: { FOO: 'bar' },
    });
    expect(cpMock.__calls[1].args).toEqual(['plugins', 'install', 'beta']);
    expect(cpMock.__calls[2].args).toEqual(['plugins', 'install', 'gamma']);
  });

  it('uses the injected claudeBin instead of the default', async () => {
    await writeFile(join(dir, 'pangolin-plugins.json'), JSON.stringify(['one']), 'utf8');

    await installPluginsFromManifest({
      workspaceDir: dir,
      env: {},
      claudeBin: '/custom/path/claude',
    });

    expect(cpMock.__calls).toHaveLength(1);
    expect(cpMock.__calls[0].bin).toBe('/custom/path/claude');
  });

  it('rejects non-array manifest shapes', async () => {
    await writeFile(
      join(dir, 'pangolin-plugins.json'),
      JSON.stringify({ plugins: ['alpha'] }),
      'utf8',
    );

    await expect(installPluginsFromManifest({ workspaceDir: dir, env: {} })).rejects.toThrow(
      /JSON array/,
    );
    expect(cpMock.__calls).toHaveLength(0);
  });

  it('throws a clear, plugin-named error when an install exits non-zero', async () => {
    await writeFile(join(dir, 'pangolin-plugins.json'), JSON.stringify(['broken-plugin']), 'utf8');
    cpMock.__config.nextExitCode = 2;

    await expect(installPluginsFromManifest({ workspaceDir: dir, env: {} })).rejects.toThrow(
      /broken-plugin/,
    );
  });

  it('stops at the first failing plugin (sequential, fail-fast)', async () => {
    await writeFile(
      join(dir, 'pangolin-plugins.json'),
      JSON.stringify(['bad', 'never-reached']),
      'utf8',
    );
    cpMock.__config.nextExitCode = 1;

    await expect(installPluginsFromManifest({ workspaceDir: dir, env: {} })).rejects.toThrow(/bad/);
    // Only the first plugin should have been attempted.
    expect(cpMock.__calls).toHaveLength(1);
    expect(cpMock.__calls[0].args).toEqual(['plugins', 'install', 'bad']);
  });

  it('accepts an empty array manifest as a successful no-op', async () => {
    await writeFile(join(dir, 'pangolin-plugins.json'), JSON.stringify([]), 'utf8');

    await expect(
      installPluginsFromManifest({ workspaceDir: dir, env: {} }),
    ).resolves.toBeUndefined();
    expect(cpMock.__calls).toHaveLength(0);
  });

  it('captures install output and throws with it on failure; never inherits stdio (F3)', async () => {
    await writeFile(join(dir, 'pangolin-plugins.json'), JSON.stringify(['p']), 'utf8');

    const workspaceDir = dir;
    const cp2 = cpMock;
    cp2.__config.nextStdout = 'marker-OUTPUT-123';
    cp2.__config.nextExitCode = 3;
    const chunks: string[] = [];
    await expect(
      installPluginsFromManifest({
        workspaceDir,
        env: {},
        claudeBin: 'claude',
        onOutput: (c) => chunks.push(c.text),
      }),
    ).rejects.toThrow(/plugins install .*code 3.*marker-OUTPUT-123/s);
    expect(chunks.join('')).toContain('marker-OUTPUT-123');
    expect(cp2.__calls.at(-1)!.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });
});

/**
 * Timeout enforcement (KNOWN-ISSUES 9).
 *
 * `PANGOLIN_PLUGIN_INSTALL_TIMEOUT_SECONDS` was emitted by the dispatch client
 * and read by nothing, so a plugin install that hung — a stalled network fetch
 * being the obvious way — hung the whole task with no bound anywhere in the
 * stack. A timeout throws, matching this module's existing fail-fast contract
 * for a failed install, and names the offending plugin the same way.
 */
describe('installPluginsFromManifest timeout', () => {
  it('throws, naming the plugin, when an install exceeds the bound', async () => {
    await writeFile(join(dir, 'pangolin-plugins.json'), JSON.stringify(['slow-plugin']), 'utf8');
    cpMock.__config.hang = true;

    await expect(
      installPluginsFromManifest({
        workspaceDir: dir,
        env: {},
        timeoutSeconds: 1,
      }),
    ).rejects.toThrow(/slow-plugin.*timed out after 1s/s);
  }, 20_000);

  it('sends SIGTERM first, then escalates to SIGKILL if the child ignores it', async () => {
    await writeFile(join(dir, 'pangolin-plugins.json'), JSON.stringify(['stubborn']), 'utf8');
    cpMock.__config.hang = true;
    cpMock.__config.ignoreTerm = true;

    await expect(
      installPluginsFromManifest({
        workspaceDir: dir,
        env: {},
        timeoutSeconds: 1,
        killGraceSeconds: 1,
      }),
    ).rejects.toThrow(/stubborn/);

    expect(cpMock.__signals).toEqual(['SIGTERM', 'SIGKILL']);
  }, 20_000);

  it('does not kill an install that finishes inside the bound', async () => {
    await writeFile(join(dir, 'pangolin-plugins.json'), JSON.stringify(['fast']), 'utf8');

    await expect(
      installPluginsFromManifest({
        workspaceDir: dir,
        env: {},
        timeoutSeconds: 30,
      }),
    ).resolves.toBeUndefined();

    expect(cpMock.__signals).toEqual([]);
  });

  it('applies the bound per plugin, not across the whole manifest', async () => {
    // Two plugins that each finish quickly must both install under a bound
    // that neither exceeds individually.
    await writeFile(join(dir, 'pangolin-plugins.json'), JSON.stringify(['a', 'b']), 'utf8');

    await expect(
      installPluginsFromManifest({ workspaceDir: dir, env: {}, timeoutSeconds: 30 }),
    ).resolves.toBeUndefined();
    expect(cpMock.__calls).toHaveLength(2);
    expect(cpMock.__signals).toEqual([]);
  });

  it('omitting timeoutSeconds leaves installs unbounded (unchanged behaviour)', async () => {
    await writeFile(join(dir, 'pangolin-plugins.json'), JSON.stringify(['x']), 'utf8');

    await expect(
      installPluginsFromManifest({ workspaceDir: dir, env: {} }),
    ).resolves.toBeUndefined();
    expect(cpMock.__signals).toEqual([]);
  });
});
