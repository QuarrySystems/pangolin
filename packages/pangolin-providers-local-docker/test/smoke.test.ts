import { describe, it, expect, vi } from 'vitest';
import { LocalDockerProvider, type LocalDockerProviderOpts } from '../src/index.js';
import { UnpinnedImageError } from '@quarry-systems/pangolin-core';
import type { TaskSpec, ProviderContext } from '@quarry-systems/pangolin-core';

const PINNED = 'busybox@sha256:' + 'a'.repeat(64);
const baseCtx: ProviderContext = { credentials: { kind: 'none' } };

const baseSpec = (overrides: Partial<TaskSpec> = {}): TaskSpec => ({
  image: PINNED,
  env: {},
  secretRefs: {},
  dispatchId: 'd1',
  ...overrides,
});

describe('LocalDockerProvider — exports and identity', () => {
  it('exposes LocalDockerProvider as a class', () => {
    expect(typeof LocalDockerProvider).toBe('function');
  });

  it('has name === "local-docker"', () => {
    const fakeDocker = { createContainer: async () => ({ id: 'x', start: async () => {} }) };
    const provider = new LocalDockerProvider({ docker: fakeDocker as never });
    expect(provider.name).toBe('local-docker');
  });

  it('LocalDockerProviderOpts is a usable type', () => {
    const opts: LocalDockerProviderOpts = { allowUnpinnedImage: false, sigtermGraceSeconds: 5 };
    expect(opts.sigtermGraceSeconds).toBe(5);
  });
});

describe('LocalDockerProvider.run — image pin enforcement (§7.4)', () => {
  it('rejects images without a digest pin', async () => {
    const provider = new LocalDockerProvider();
    await expect(provider.run(baseSpec({ image: 'busybox:latest' }), baseCtx)).rejects.toBeInstanceOf(
      UnpinnedImageError,
    );
  });

  it('rejects bare image names without a digest pin', async () => {
    const provider = new LocalDockerProvider();
    await expect(provider.run(baseSpec({ image: 'busybox' }), baseCtx)).rejects.toBeInstanceOf(
      UnpinnedImageError,
    );
  });

  it('rejects sha256 references that are not in the @sha256: form', async () => {
    const provider = new LocalDockerProvider();
    await expect(
      provider.run(baseSpec({ image: 'busybox:sha256-' + 'a'.repeat(64) }), baseCtx),
    ).rejects.toBeInstanceOf(UnpinnedImageError);
  });

  it('allows an unpinned image when allowUnpinnedImage: true', async () => {
    const fakeDocker = {
      createContainer: vi.fn(async () => ({ id: 'c1', start: async () => {} })),
    };
    const provider = new LocalDockerProvider({
      docker: fakeDocker as never,
      allowUnpinnedImage: true,
    });
    const handle = await provider.run(baseSpec({ image: 'busybox:latest' }), baseCtx);
    expect(handle.providerTaskId).toBe('c1');
  });

  it('accepts digest-pinned images by default', async () => {
    const fakeDocker = {
      createContainer: vi.fn(async () => ({ id: 'c2', start: async () => {} })),
    };
    const provider = new LocalDockerProvider({ docker: fakeDocker as never });
    const handle = await provider.run(baseSpec(), baseCtx);
    expect(handle.providerTaskId).toBe('c2');
  });
});

describe('LocalDockerProvider.run — container creation contract', () => {
  it('passes image, env (as KEY=value strings), and command to createContainer', async () => {
    const createSpy = vi.fn(async () => ({ id: 'c3', start: async () => {} }));
    const fakeDocker = { createContainer: createSpy };
    const provider = new LocalDockerProvider({ docker: fakeDocker as never });

    await provider.run(
      baseSpec({
        env: { FOO: 'bar', BAZ: 'qux' },
        command: ['echo', 'hello'],
      }),
      baseCtx,
    );

    expect(createSpy).toHaveBeenCalledTimes(1);
    const arg = createSpy.mock.calls[0]![0] as {
      Image: string;
      Env: string[];
      Cmd?: string[];
    };
    expect(arg.Image).toBe(PINNED);
    expect(arg.Env).toEqual(expect.arrayContaining(['FOO=bar', 'BAZ=qux']));
    expect(arg.Env).toHaveLength(2);
    expect(arg.Cmd).toEqual(['echo', 'hello']);
  });

  it('sets Labels including pangolin.dispatchId for post-hoc discovery', async () => {
    const createSpy = vi.fn(async () => ({ id: 'c4', start: async () => {} }));
    const fakeDocker = { createContainer: createSpy };
    const provider = new LocalDockerProvider({ docker: fakeDocker as never });

    await provider.run(baseSpec({ dispatchId: 'dispatch-xyz' }), baseCtx);

    const arg = createSpy.mock.calls[0]![0] as { Labels: Record<string, string> };
    expect(arg.Labels['pangolin.dispatchId']).toBe('dispatch-xyz');
  });

  it('starts the created container before returning', async () => {
    const startSpy = vi.fn(async () => {});
    const fakeDocker = {
      createContainer: async () => ({ id: 'c5', start: startSpy }),
    };
    const provider = new LocalDockerProvider({ docker: fakeDocker as never });

    await provider.run(baseSpec(), baseCtx);

    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('returns providerTaskId === container.id', async () => {
    const fakeDocker = {
      createContainer: async () => ({ id: 'container-id-abc', start: async () => {} }),
    };
    const provider = new LocalDockerProvider({ docker: fakeDocker as never });

    const handle = await provider.run(baseSpec(), baseCtx);
    expect(handle.providerTaskId).toBe('container-id-abc');
  });
});

describe('LocalDockerProvider.run — secret store bind-mount', () => {
  it('bind-mounts PANGOLIN_SECRET_STORE_DIR and rewrites it to the in-container path', async () => {
    const createSpy = vi.fn(async () => ({ id: 'cs1', start: async () => {} }));
    const provider = new LocalDockerProvider({
      docker: { createContainer: createSpy } as never,
    });

    await provider.run(
      baseSpec({ env: { PANGOLIN_SECRET_STORE_DIR: '/host/tmp/pangolin-secrets-abc' } }),
      baseCtx,
    );

    const arg = createSpy.mock.calls[0]![0] as {
      Env: string[];
      HostConfig?: { Binds?: string[] };
    };
    expect(arg.HostConfig?.Binds).toContain(
      '/host/tmp/pangolin-secrets-abc:/pangolin/secrets',
    );
    expect(arg.Env).toContain('PANGOLIN_SECRET_STORE_DIR=/pangolin/secrets');
  });

  it('honors a custom secretStoreMountTarget', async () => {
    const createSpy = vi.fn(async () => ({ id: 'cs2', start: async () => {} }));
    const provider = new LocalDockerProvider({
      docker: { createContainer: createSpy } as never,
      secretStoreMountTarget: '/custom/secrets',
    });

    await provider.run(
      baseSpec({ env: { PANGOLIN_SECRET_STORE_DIR: '/host/s' } }),
      baseCtx,
    );

    const arg = createSpy.mock.calls[0]![0] as {
      Env: string[];
      HostConfig?: { Binds?: string[] };
    };
    expect(arg.HostConfig?.Binds).toContain('/host/s:/custom/secrets');
    expect(arg.Env).toContain('PANGOLIN_SECRET_STORE_DIR=/custom/secrets');
  });

  it('adds no secrets bind or env when PANGOLIN_SECRET_STORE_DIR is unset', async () => {
    const createSpy = vi.fn(async () => ({ id: 'cs3', start: async () => {} }));
    const provider = new LocalDockerProvider({
      docker: { createContainer: createSpy } as never,
    });

    await provider.run(baseSpec({ env: { FOO: 'bar' } }), baseCtx);

    const arg = createSpy.mock.calls[0]![0] as {
      Env: string[];
      HostConfig?: { Binds?: string[] };
    };
    expect(arg.Env.some((e) => e.startsWith('PANGOLIN_SECRET_STORE_DIR='))).toBe(false);
    expect((arg.HostConfig?.Binds ?? []).some((b) => b.includes('/pangolin/secrets'))).toBe(
      false,
    );
  });
});

describe('LocalDockerProvider.awaitExit — terminal state collection', () => {
  // Build a docker-stream-multiplexed buffer: [type(1)][0,0,0][size(4 BE)][payload]
  const frame = (type: 1 | 2, payload: string): Buffer => {
    const data = Buffer.from(payload, 'utf8');
    const header = Buffer.alloc(8);
    header.writeUInt8(type, 0);
    header.writeUInt32BE(data.length, 4);
    return Buffer.concat([header, data]);
  };

  it('waits for the container, captures stdout/stderr, and returns TaskExit', async () => {
    const logsBuf = Buffer.concat([
      frame(1, 'hello stdout\n'),
      frame(2, 'oops stderr\n'),
      frame(1, 'more stdout\n'),
    ]);
    const container = {
      wait: vi.fn(async () => ({ StatusCode: 0 })),
      logs: vi.fn(async () => logsBuf),
      inspect: vi.fn(async () => ({
        State: {
          StartedAt: '2026-05-21T10:00:00.000Z',
          FinishedAt: '2026-05-21T10:00:05.000Z',
          ExitCode: 0,
        },
      })),
    };
    const fakeDocker = {
      getContainer: vi.fn(() => container),
    };
    const provider = new LocalDockerProvider({ docker: fakeDocker as never });

    const exit = await provider.awaitExit({ providerTaskId: 'c-1' }, baseCtx);

    expect(fakeDocker.getContainer).toHaveBeenCalledWith('c-1');
    expect(container.wait).toHaveBeenCalledTimes(1);
    expect(container.logs).toHaveBeenCalledWith(
      expect.objectContaining({ stdout: true, stderr: true, follow: false }),
    );
    expect(exit.exitCode).toBe(0);
    expect(exit.stdout).toBe('hello stdout\nmore stdout\n');
    expect(exit.stderr).toBe('oops stderr\n');
    expect(exit.startedAt).toEqual(new Date('2026-05-21T10:00:00.000Z'));
    expect(exit.finishedAt).toEqual(new Date('2026-05-21T10:00:05.000Z'));
  });

  it('propagates non-zero exit codes from inspect.State.ExitCode', async () => {
    const container = {
      wait: vi.fn(async () => ({ StatusCode: 137 })),
      logs: vi.fn(async () => Buffer.alloc(0)),
      inspect: vi.fn(async () => ({
        State: {
          StartedAt: '2026-05-21T10:00:00.000Z',
          FinishedAt: '2026-05-21T10:00:01.000Z',
          ExitCode: 137,
        },
      })),
    };
    const fakeDocker = { getContainer: () => container };
    const provider = new LocalDockerProvider({ docker: fakeDocker as never });

    const exit = await provider.awaitExit({ providerTaskId: 'c-1' }, baseCtx);
    expect(exit.exitCode).toBe(137);
    expect(exit.stdout).toBe('');
    expect(exit.stderr).toBe('');
  });
});

describe('LocalDockerProvider.cancel — graceful then forceful kill', () => {
  it('sends SIGTERM, observes stopped state, and does not escalate to SIGKILL', async () => {
    const killSpy = vi.fn(async () => {});
    const inspectSpy = vi.fn(async () => ({ State: { Running: false, Status: 'exited' } }));
    const container = { kill: killSpy, inspect: inspectSpy };
    const fakeDocker = { getContainer: () => container };
    const provider = new LocalDockerProvider({
      docker: fakeDocker as never,
      sigtermGraceSeconds: 1,
    });

    await provider.cancel({ providerTaskId: 'c-1' }, baseCtx);

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy.mock.calls[0]![0]).toEqual({ signal: 'SIGTERM' });
  });

  it('resolves cleanly when SIGTERM races with container already stopped (409 Conflict)', async () => {
    // Reproduces the race where the container exits between the caller's
    // decision to cancel and cancel() actually firing — Docker returns 409
    // and dockerode rejects. cancel() must swallow that and verify terminal
    // state via inspect(), not throw.
    const killSpy = vi.fn(async () => {
      throw new Error('(HTTP code 409) unexpected - Container is not running');
    });
    const inspectSpy = vi.fn(async () => ({ State: { Running: false, Status: 'exited' } }));
    const container = { kill: killSpy, inspect: inspectSpy };
    const fakeDocker = { getContainer: () => container };
    const provider = new LocalDockerProvider({
      docker: fakeDocker as never,
      sigtermGraceSeconds: 1,
    });

    await expect(provider.cancel({ providerTaskId: 'c-1' }, baseCtx)).resolves.toBeUndefined();

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy.mock.calls[0]![0]).toEqual({ signal: 'SIGTERM' });
    expect(inspectSpy).toHaveBeenCalled();
  });

  it('escalates to SIGKILL when grace period elapses without stop', async () => {
    vi.useFakeTimers();
    try {
      const killSpy = vi.fn(async () => {});
      const inspectSpy = vi.fn(async () => ({ State: { Running: true, Status: 'running' } }));
      const container = { kill: killSpy, inspect: inspectSpy };
      const fakeDocker = { getContainer: () => container };
      const provider = new LocalDockerProvider({
        docker: fakeDocker as never,
        sigtermGraceSeconds: 2,
      });

      const cancelPromise = provider.cancel({ providerTaskId: 'c-1' }, baseCtx);

      // Drain the fake timers — the implementation polls inspect() then escalates.
      await vi.advanceTimersByTimeAsync(2500);
      await cancelPromise;

      const signals = killSpy.mock.calls.map((c) => (c[0] as { signal: string }).signal);
      expect(signals).toContain('SIGTERM');
      expect(signals).toContain('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });
});
