import { attachDispatchCmd } from '../src/cmd-dispatch.js';
import { Command } from 'commander';
import { it, expect, vi } from 'vitest';

it('attachDispatchCmd registers run/describe/cancel subcommands', () => {
  const program = new Command();
  attachDispatchCmd(program, { getClient: async () => ({}) as never });
  const d = program.commands.find((c) => c.name() === 'dispatch')!;
  expect(d.commands.map((c) => c.name()).sort()).toEqual(['cancel', 'describe', 'run']);
});

it('dispatch run calls client.dispatch and prints result as JSON', async () => {
  const mockDispatchResult = {
    dispatchId: 'test-id',
    exitCode: 0,
    stdout: 'output',
    stderr: '',
    durationMs: 1000,
    resolved: {
      subagent: { name: 'my-subagent', contentHash: 'abc123', registeredAt: '2025-01-01' },
      capabilities: [],
      env: [],
    },
  };

  const mockClient = {
    dispatch: vi.fn().mockResolvedValue(mockDispatchResult),
  };

  const mockCtx = {
    getClient: vi.fn().mockResolvedValue(mockClient),
  };

  const program = new Command();
  attachDispatchCmd(program, mockCtx);

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = vi.fn((msg: string) => logs.push(msg));

  try {
    await program.parseAsync(
      [
        'dispatch',
        'run',
        '--subagent',
        'my-subagent',
        '--target',
        'prod',
        '--env',
        'base',
        '--input',
        '{"x":1}',
        '--capability',
        'cap1',
      ],
      { from: 'user' },
    );

    expect(mockClient.dispatch).toHaveBeenCalledWith({
      subagent: 'my-subagent',
      env: ['base'],
      input: { x: 1 },
      capabilities: ['cap1'],
      addCapabilities: undefined,
      target: 'prod',
      workerImage: 'ghcr.io/quarrysystems/pangolin-worker:latest',
    });

    expect(logs.length).toBeGreaterThan(0);
    const output = logs[0];
    expect(JSON.parse(output)).toEqual(mockDispatchResult);
  } finally {
    console.log = originalLog;
  }
});

it('dispatch run exits with code 1 if result.failure is set', async () => {
  const mockDispatchResult = {
    dispatchId: 'test-id',
    exitCode: 1,
    stdout: '',
    stderr: 'error',
    durationMs: 1000,
    failure: { kind: 'timeout' },
    resolved: {
      subagent: { name: 'my-subagent', contentHash: 'abc123', registeredAt: '2025-01-01' },
      capabilities: [],
      env: [],
    },
  };

  const mockClient = {
    dispatch: vi.fn().mockResolvedValue(mockDispatchResult),
  };

  const mockCtx = {
    getClient: vi.fn().mockResolvedValue(mockClient),
  };

  const program = new Command();
  attachDispatchCmd(program, mockCtx);

  const logs: string[] = [];
  const originalLog = console.log;
  const originalExit = process.exit;
  let exitCode: number | undefined;

  console.log = vi.fn((msg: string) => logs.push(msg));
  process.exit = vi.fn((code?: number) => {
    exitCode = code;
    throw new Error('exit');
  }) as never;

  try {
    await program.parseAsync(['dispatch', 'run', '--subagent', 'my-subagent', '--target', 'prod'], {
      from: 'user',
    });
  } catch {
    // Expected to throw due to process.exit mock
  } finally {
    console.log = originalLog;
    process.exit = originalExit;
  }

  expect(exitCode).toBe(1);
});

it('dispatch run exits 1 on a non-zero worker exitCode even without a failure block', async () => {
  // bundled-impls intentionally leaves `failure` unset for an app-level non-zero exit
  // (failure = provider/infra only). The CLI must STILL exit non-zero so a crashed
  // worker is never reported as success.
  const mockDispatchResult = {
    dispatchId: 'test-id',
    exitCode: 1,
    stdout: '',
    stderr: '',
    durationMs: 5,
    resolved: {
      subagent: { name: 's', contentHash: 'h', registeredAt: 't' },
      capabilities: [],
      env: [],
    },
  };
  const mockClient = { dispatch: vi.fn().mockResolvedValue(mockDispatchResult) };
  const mockCtx = { getClient: vi.fn().mockResolvedValue(mockClient) };

  const program = new Command();
  attachDispatchCmd(program, mockCtx);

  const originalLog = console.log;
  const originalExit = process.exit;
  let exitCode: number | undefined;
  console.log = vi.fn();
  process.exit = vi.fn((code?: number) => {
    exitCode = code;
    throw new Error('exit');
  }) as never;

  try {
    await program.parseAsync(['dispatch', 'run', '--subagent', 's', '--target', 'prod'], {
      from: 'user',
    });
  } catch {
    // expected: the process.exit mock throws
  } finally {
    console.log = originalLog;
    process.exit = originalExit;
  }

  expect(exitCode).toBe(1);
});

it('dispatch describe fetches and prints dispatch record as JSON', async () => {
  const mockDispatchResult = {
    dispatchId: 'test-id',
    exitCode: 0,
    stdout: 'output',
    stderr: '',
    durationMs: 1000,
    resolved: {
      subagent: { name: 'my-subagent', contentHash: 'abc123', registeredAt: '2025-01-01' },
      capabilities: [],
      env: [],
    },
  };

  const mockClient = {
    dispatch: {
      describe: vi.fn().mockResolvedValue(mockDispatchResult),
    },
  };

  const mockCtx = {
    getClient: vi.fn().mockResolvedValue(mockClient),
  };

  const program = new Command();
  attachDispatchCmd(program, mockCtx);

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = vi.fn((msg: string) => logs.push(msg));

  try {
    await program.parseAsync(['dispatch', 'describe', 'test-id'], { from: 'user' });

    expect(mockClient.dispatch.describe).toHaveBeenCalledWith('test-id');
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.parse(logs[0])).toEqual(mockDispatchResult);
  } finally {
    console.log = originalLog;
  }
});

it('dispatch cancel calls client.dispatch.cancel and prints confirmation', async () => {
  const mockClient = {
    dispatch: {
      cancel: vi.fn().mockResolvedValue(undefined),
    },
  };

  const mockCtx = {
    getClient: vi.fn().mockResolvedValue(mockClient),
  };

  const program = new Command();
  attachDispatchCmd(program, mockCtx);

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = vi.fn((msg: string) => logs.push(msg));

  try {
    await program.parseAsync(['dispatch', 'cancel', 'test-id'], { from: 'user' });

    expect(mockClient.dispatch.cancel).toHaveBeenCalledWith('test-id');
    expect(logs[0]).toContain('cancelled');
    expect(logs[0]).toContain('test-id');
  } finally {
    console.log = originalLog;
  }
});

it('dispatch run exits 1 and prints error message on invalid JSON input without calling client.dispatch', async () => {
  const mockClient = {
    dispatch: vi.fn().mockResolvedValue({}),
  };

  const mockCtx = {
    getClient: vi.fn().mockResolvedValue(mockClient),
  };

  const program = new Command();
  attachDispatchCmd(program, mockCtx);

  const errors: string[] = [];
  const originalError = console.error;
  const originalExit = process.exit;
  let exitCode: number | undefined;

  console.error = vi.fn((msg: string) => errors.push(msg));
  process.exit = vi.fn((code?: number) => {
    exitCode = code;
    throw new Error('exit');
  }) as never;

  try {
    await program.parseAsync(
      [
        'dispatch',
        'run',
        '--subagent',
        'my-subagent',
        '--target',
        'prod',
        '--input',
        'not valid json {',
      ],
      { from: 'user' },
    );
  } catch {
    // Expected to throw due to process.exit mock
  } finally {
    console.error = originalError;
    process.exit = originalExit;
  }

  expect(exitCode).toBe(1);
  expect(errors.length).toBeGreaterThan(0);
  expect(errors[0]).toContain('pangolin dispatch run');
  expect(errors[0]).toContain('--input');
  expect(errors[0]).toContain('not valid JSON');
  expect(mockClient.dispatch).not.toHaveBeenCalled();
});
