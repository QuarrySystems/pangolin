// Integration tests for `FargateProvider` against a fake ECS client.
//
// "Integration" here means: we exercise the provider end-to-end through its
// public methods (`run`, `awaitExit`, `cancel`) with a fake ECS client that
// records the actual `Command` objects the provider hands to `send`. This
// verifies the contract the AWS SDK shape implies — the wire structure of
// `RunTaskCommand`, the `DescribeTasks` polling loop, and the `StopTask`
// cancellation — without ever touching a live AWS account.
//
// Live-AWS verification belongs to DAG 3's E2E matrix; this suite is the
// type/shape gate.

import { FargateProvider } from '../src/index.js';
import { describe, it, expect, vi } from 'vitest';
import {
  DescribeTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';

/**
 * Build a stand-in ECS client whose `send` discriminates by command
 * constructor name (e.g. `'RunTaskCommand'`). Each handler receives the
 * command's `input` and returns the body of the would-be SDK response.
 */
function fakeEcs(handlers: Record<string, (input: any) => any>) {
  return {
    send: vi.fn(async (cmd: any) => {
      const name = cmd.constructor.name;
      const fn = handlers[name];
      if (!fn) throw new Error(`unhandled command in fake ECS: ${name}`);
      return fn(cmd.input);
    }),
  } as any;
}

describe('FargateProvider', () => {
  it('RunTask carries the dispatchId tag, env entries, and digest-pinned image', async () => {
    const calls: any[] = [];
    const provider = new FargateProvider({
      cluster: 'c',
      taskDefinitionFamily: 'pangolin-worker',
      subnets: ['sn-1'],
      securityGroups: ['sg-1'],
      ecsClient: fakeEcs({
        RunTaskCommand: (input: any) => {
          calls.push(input);
          return { tasks: [{ taskArn: 'arn:t1' }] };
        },
      }),
    });
    const handle = await provider.run(
      { image: 'foo@sha256:' + 'c'.repeat(64), env: { K: 'v' }, secretRefs: {}, dispatchId: 'd1' },
      { credentials: { kind: 'aws' } },
    );
    expect(handle.providerTaskId).toBe('arn:t1');
    expect(calls[0].tags).toContainEqual({ key: 'pangolin:dispatchId', value: 'd1' });
    expect(calls[0].overrides.containerOverrides[0].environment).toContainEqual({
      name: 'K',
      value: 'v',
    });
    // ECS does not permit overriding `image` on RunTask container overrides
    // (the image is locked in by the task definition). The implementer's
    // RunTaskCommand input therefore must NOT include `image` on the
    // container override — only env/command/cpu/memory.
    expect(calls[0].overrides.containerOverrides[0].image).toBeUndefined();
  });

  it('awaitExit polls DescribeTasks until STOPPED and reports exitCode', async () => {
    vi.useFakeTimers();
    try {
      // Two pre-terminal polls (RUNNING) then a terminal STOPPED.
      const states = [
        { lastStatus: 'RUNNING' },
        { lastStatus: 'RUNNING' },
        {
          lastStatus: 'STOPPED',
          startedAt: new Date('2026-05-21T12:00:00.000Z'),
          stoppedAt: new Date('2026-05-21T12:00:07.000Z'),
          stopCode: 'EssentialContainerExited',
          containers: [{ name: 'pangolin-worker', exitCode: 42 }],
        },
      ];
      let i = 0;
      const describeInputs: any[] = [];
      const ecs = fakeEcs({
        DescribeTasksCommand: (input: any) => {
          describeInputs.push(input);
          return { tasks: [states[i++] ?? states[states.length - 1]] };
        },
      });
      const provider = new FargateProvider({
        cluster: 'c',
        taskDefinitionFamily: 'pangolin-worker',
        subnets: ['sn-1'],
        securityGroups: ['sg-1'],
        pollIntervalMs: 1000,
        ecsClient: ecs,
      });

      const exitPromise = provider.awaitExit(
        { providerTaskId: 'arn:t1' },
        { credentials: { kind: 'aws' } },
      );

      // Drive through both pre-terminal sleeps so the loop reaches the
      // STOPPED state and resolves.
      await vi.advanceTimersByTimeAsync(5000);
      const exit = await exitPromise;

      // Loop polled until STOPPED — at least the two pre-terminal polls
      // plus the terminal one.
      const calls = (ecs.send as ReturnType<typeof vi.fn>).mock.calls;
      const describeCalls = calls.filter((c) => c[0] instanceof DescribeTasksCommand);
      expect(describeCalls.length).toBeGreaterThanOrEqual(3);

      // Every poll targets the configured cluster and task ARN.
      expect(describeInputs[0]).toEqual({ cluster: 'c', tasks: ['arn:t1'] });

      // Exit reflects the terminal container's exitCode and lifecycle dates.
      expect(exit.exitCode).toBe(42);
      expect(exit.startedAt).toEqual(new Date('2026-05-21T12:00:00.000Z'));
      expect(exit.finishedAt).toEqual(new Date('2026-05-21T12:00:07.000Z'));
      expect(exit.stdout).toBe('');
      expect(exit.stderr).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel calls StopTask with pangolin.cancel reason', async () => {
    let captured: { cluster?: string; task?: string; reason?: string } | null = null;
    let capturedCmd: unknown = null;
    const provider = new FargateProvider({
      cluster: 'c',
      taskDefinitionFamily: 'pangolin-worker',
      subnets: ['sn-1'],
      securityGroups: ['sg-1'],
      ecsClient: {
        send: vi.fn(async (cmd: any) => {
          capturedCmd = cmd;
          captured = cmd.input;
          return {};
        }),
      } as any,
    });

    await provider.cancel(
      { providerTaskId: 'arn:t1' },
      { credentials: { kind: 'aws' } },
    );

    expect(capturedCmd).toBeInstanceOf(StopTaskCommand);
    expect(captured!.cluster).toBe('c');
    expect(captured!.task).toBe('arn:t1');
    expect(captured!.reason).toBe('pangolin.cancel');
  });
});

// Silence unused-import lint: RunTaskCommand is referenced for symmetry with
// the other AWS commands the suite asserts on; the actual assertion uses the
// `calls` array's recorded `input` rather than the command constructor.
void RunTaskCommand;
