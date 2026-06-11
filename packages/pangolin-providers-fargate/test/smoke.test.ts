import { describe, it, expect, vi } from 'vitest';
import { FargateProvider, type FargateProviderOpts } from '../src/index.js';
import {
  UnpinnedImageError,
  type ProviderContext,
  type TaskSpec,
} from '@quarry-systems/pangolin-core';
import {
  DescribeTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';

const PINNED = 'public.ecr.aws/pangolin/worker@sha256:' + 'a'.repeat(64);
const baseCtx: ProviderContext = { credentials: { kind: 'aws' } };

const baseSpec = (overrides: Partial<TaskSpec> = {}): TaskSpec => ({
  image: PINNED,
  env: {},
  secretRefs: {},
  dispatchId: 'd1',
  ...overrides,
});

const baseOpts = (overrides: Partial<FargateProviderOpts> = {}): FargateProviderOpts => ({
  cluster: 'test-cluster',
  taskDefinitionFamily: 'pangolin-worker',
  subnets: ['subnet-1', 'subnet-2'],
  securityGroups: ['sg-1'],
  ...overrides,
});

/**
 * Build an ECS client stand-in with a `send` spy that dispatches by command
 * constructor name. Each handler receives the command instance and returns
 * the body of the would-be SDK response.
 */
function fakeEcs(handlers: Record<string, (cmd: unknown) => unknown>) {
  const send = vi.fn(async (cmd: { constructor: { name: string } }) => {
    const handler = handlers[cmd.constructor.name];
    if (!handler) {
      throw new Error(`fakeEcs: no handler registered for ${cmd.constructor.name}`);
    }
    return handler(cmd);
  });
  return { send } as never;
}

describe('FargateProvider — exports and identity', () => {
  it('exposes FargateProvider as a class', () => {
    expect(typeof FargateProvider).toBe('function');
  });

  it('has name === "fargate"', () => {
    const provider = new FargateProvider(baseOpts({ ecsClient: fakeEcs({}) }));
    expect(provider.name).toBe('fargate');
  });

  it('FargateProviderOpts is a usable type', () => {
    const opts: FargateProviderOpts = baseOpts({ assignPublicIp: 'ENABLED' });
    expect(opts.assignPublicIp).toBe('ENABLED');
  });
});

describe('FargateProvider.run — image pin enforcement (§7.4)', () => {
  it('rejects images without a digest pin', async () => {
    const provider = new FargateProvider(baseOpts({ ecsClient: fakeEcs({}) }));
    await expect(
      provider.run(baseSpec({ image: 'pangolin-worker:latest' }), baseCtx),
    ).rejects.toBeInstanceOf(UnpinnedImageError);
  });

  it('rejects bare image names without a digest pin', async () => {
    const provider = new FargateProvider(baseOpts({ ecsClient: fakeEcs({}) }));
    await expect(provider.run(baseSpec({ image: 'pangolin-worker' }), baseCtx)).rejects.toBeInstanceOf(
      UnpinnedImageError,
    );
  });

  it('rejects sha256 references not in the @sha256: form', async () => {
    const provider = new FargateProvider(baseOpts({ ecsClient: fakeEcs({}) }));
    await expect(
      provider.run(baseSpec({ image: 'pangolin-worker:sha256-' + 'a'.repeat(64) }), baseCtx),
    ).rejects.toBeInstanceOf(UnpinnedImageError);
  });

  it('allows an unpinned image when allowUnpinnedImage: true', async () => {
    const provider = new FargateProvider(
      baseOpts({
        allowUnpinnedImage: true,
        ecsClient: fakeEcs({
          RunTaskCommand: () => ({ tasks: [{ taskArn: 'arn:aws:ecs:::task/c1' }] }),
        }),
      }),
    );
    const handle = await provider.run(baseSpec({ image: 'pangolin-worker:latest' }), baseCtx);
    expect(handle.providerTaskId).toBe('arn:aws:ecs:::task/c1');
  });

  it('accepts digest-pinned images by default', async () => {
    const provider = new FargateProvider(
      baseOpts({
        ecsClient: fakeEcs({
          RunTaskCommand: () => ({ tasks: [{ taskArn: 'arn:aws:ecs:::task/c2' }] }),
        }),
      }),
    );
    const handle = await provider.run(baseSpec(), baseCtx);
    expect(handle.providerTaskId).toBe('arn:aws:ecs:::task/c2');
  });
});

describe('FargateProvider.run — RunTask contract', () => {
  it('calls RunTaskCommand with cluster, task-definition family, launchType FARGATE, and awsvpc network config', async () => {
    let captured: RunTaskCommand | null = null;
    const provider = new FargateProvider(
      baseOpts({
        cluster: 'prod-cluster',
        taskDefinitionFamily: 'pangolin-worker-prod',
        subnets: ['subnet-a', 'subnet-b'],
        securityGroups: ['sg-x', 'sg-y'],
        assignPublicIp: 'ENABLED',
        ecsClient: fakeEcs({
          RunTaskCommand: (cmd) => {
            captured = cmd as RunTaskCommand;
            return { tasks: [{ taskArn: 'arn:1' }] };
          },
        }),
      }),
    );

    await provider.run(baseSpec(), baseCtx);

    expect(captured).toBeInstanceOf(RunTaskCommand);
    const input = captured!.input;
    expect(input.cluster).toBe('prod-cluster');
    expect(input.taskDefinition).toBe('pangolin-worker-prod');
    expect(input.launchType).toBe('FARGATE');
    expect(input.networkConfiguration?.awsvpcConfiguration).toEqual({
      subnets: ['subnet-a', 'subnet-b'],
      securityGroups: ['sg-x', 'sg-y'],
      assignPublicIp: 'ENABLED',
    });
  });

  it('defaults assignPublicIp to DISABLED when not provided', async () => {
    let captured: RunTaskCommand | null = null;
    const provider = new FargateProvider(
      baseOpts({
        ecsClient: fakeEcs({
          RunTaskCommand: (cmd) => {
            captured = cmd as RunTaskCommand;
            return { tasks: [{ taskArn: 'arn:1' }] };
          },
        }),
      }),
    );

    await provider.run(baseSpec(), baseCtx);

    expect(captured!.input.networkConfiguration?.awsvpcConfiguration?.assignPublicIp).toBe(
      'DISABLED',
    );
  });

  it('passes env, command and resources as container overrides', async () => {
    let captured: RunTaskCommand | null = null;
    const provider = new FargateProvider(
      baseOpts({
        ecsClient: fakeEcs({
          RunTaskCommand: (cmd) => {
            captured = cmd as RunTaskCommand;
            return { tasks: [{ taskArn: 'arn:1' }] };
          },
        }),
      }),
    );

    await provider.run(
      baseSpec({
        env: { FOO: 'bar', BAZ: 'qux' },
        command: ['echo', 'hello'],
        resources: { cpu: 1024, memory: 2048 },
      }),
      baseCtx,
    );

    const overrides = captured!.input.overrides;
    expect(overrides?.containerOverrides).toHaveLength(1);
    const co = overrides!.containerOverrides![0]!;
    expect(co.name).toBe('pangolin-worker');
    // ECS does not permit overriding `image` or injecting `secrets:` at
    // RunTask — both are locked in by the task definition. We only assert
    // the override carries env/command/resources; the digest-pin guard
    // and secretRefs-must-be-in-task-def guard are exercised separately.
    expect(co.command).toEqual(['echo', 'hello']);
    expect(co.cpu).toBe(1024);
    expect(co.memory).toBe(2048);
    expect(co.environment).toEqual(
      expect.arrayContaining([
        { name: 'FOO', value: 'bar' },
        { name: 'BAZ', value: 'qux' },
      ]),
    );
    expect(co.environment).toHaveLength(2);
  });

  it('rejects spec.secretRefs because ECS only honors secrets declared in the task definition', async () => {
    const provider = new FargateProvider(
      baseOpts({
        ecsClient: fakeEcs({
          RunTaskCommand: () => ({ tasks: [{ taskArn: 'arn:1' }] }),
        }),
      }),
    );

    await expect(
      provider.run(
        baseSpec({ secretRefs: { DB_PASS: 'arn:aws:secretsmanager:::secret/db-AB12' } }),
        baseCtx,
      ),
    ).rejects.toThrow(/secretRefs.*task definition/);
  });

  it('tags the task with pangolin:dispatchId for post-hoc discovery', async () => {
    let captured: RunTaskCommand | null = null;
    const provider = new FargateProvider(
      baseOpts({
        ecsClient: fakeEcs({
          RunTaskCommand: (cmd) => {
            captured = cmd as RunTaskCommand;
            return { tasks: [{ taskArn: 'arn:1' }] };
          },
        }),
      }),
    );

    await provider.run(baseSpec({ dispatchId: 'dispatch-xyz' }), baseCtx);

    expect(captured!.input.tags).toEqual(
      expect.arrayContaining([{ key: 'pangolin:dispatchId', value: 'dispatch-xyz' }]),
    );
  });

  it('returns TaskHandle with providerTaskId === task.taskArn', async () => {
    const provider = new FargateProvider(
      baseOpts({
        ecsClient: fakeEcs({
          RunTaskCommand: () => ({ tasks: [{ taskArn: 'arn:aws:ecs:::task/abc' }] }),
        }),
      }),
    );

    const handle = await provider.run(baseSpec(), baseCtx);
    expect(handle.providerTaskId).toBe('arn:aws:ecs:::task/abc');
  });

  it('throws a descriptive error when RunTask returns no task ARN (failures path)', async () => {
    const provider = new FargateProvider(
      baseOpts({
        ecsClient: fakeEcs({
          RunTaskCommand: () => ({
            tasks: [],
            failures: [{ arn: 'x', reason: 'CAPACITY' }],
          }),
        }),
      }),
    );

    await expect(provider.run(baseSpec(), baseCtx)).rejects.toThrow(/RunTask/);
  });
});

describe('FargateProvider.awaitExit — DescribeTasks polling until terminal', () => {
  it('polls DescribeTasks at pollIntervalMs until lastStatus === STOPPED and returns TaskExit', async () => {
    vi.useFakeTimers();
    try {
      const states = [
        { lastStatus: 'PROVISIONING' },
        { lastStatus: 'RUNNING' },
        {
          lastStatus: 'STOPPED',
          startedAt: new Date('2026-05-21T10:00:00.000Z'),
          stoppedAt: new Date('2026-05-21T10:00:05.000Z'),
          stopCode: 'EssentialContainerExited',
          containers: [{ name: 'pangolin-worker', exitCode: 0 }],
        },
      ];
      let i = 0;
      const ecs = fakeEcs({
        DescribeTasksCommand: () => ({ tasks: [states[i++] ?? states[states.length - 1]] }),
      });
      const provider = new FargateProvider(baseOpts({ ecsClient: ecs, pollIntervalMs: 1000 }));

      const exitPromise = provider.awaitExit({ providerTaskId: 'arn:1' }, baseCtx);

      // Advance through two pre-terminal polls + the terminal poll.
      await vi.advanceTimersByTimeAsync(5000);
      const exit = await exitPromise;

      expect(ecs.send).toHaveBeenCalled();
      const calls = (ecs.send as ReturnType<typeof vi.fn>).mock.calls;
      const describeCalls = calls.filter((c) => c[0] instanceof DescribeTasksCommand);
      expect(describeCalls.length).toBeGreaterThanOrEqual(3);
      // Each DescribeTasks call targets the configured cluster and the right ARN.
      const firstInput = (describeCalls[0]![0] as DescribeTasksCommand).input;
      expect(firstInput.cluster).toBe('test-cluster');
      expect(firstInput.tasks).toEqual(['arn:1']);

      expect(exit.exitCode).toBe(0);
      expect(exit.startedAt).toEqual(new Date('2026-05-21T10:00:00.000Z'));
      expect(exit.finishedAt).toEqual(new Date('2026-05-21T10:00:05.000Z'));
      expect(exit.stdout).toBe('');
      expect(exit.stderr).toBe('');
      expect(exit.providerFailureReason).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses default pollIntervalMs of 5000 when not provided', async () => {
    vi.useFakeTimers();
    try {
      let i = 0;
      const states = [
        { lastStatus: 'RUNNING' },
        {
          lastStatus: 'STOPPED',
          startedAt: new Date('2026-05-21T10:00:00.000Z'),
          stoppedAt: new Date('2026-05-21T10:00:01.000Z'),
          containers: [{ name: 'pangolin-worker', exitCode: 0 }],
        },
      ];
      const ecs = fakeEcs({
        DescribeTasksCommand: () => ({ tasks: [states[i++] ?? states[states.length - 1]] }),
      });
      const provider = new FargateProvider(baseOpts({ ecsClient: ecs }));

      const exitPromise = provider.awaitExit({ providerTaskId: 'arn:1' }, baseCtx);
      // After the first describe (which returns RUNNING) the provider should
      // sleep ~5s before polling again. Advance by less than 5s — exit should
      // still be pending.
      await vi.advanceTimersByTimeAsync(4000);
      const raced = await Promise.race([
        exitPromise.then(() => 'done'),
        Promise.resolve('pending'),
      ]);
      expect(raced).toBe('pending');

      // Now advance the rest of the way and confirm it resolves.
      await vi.advanceTimersByTimeAsync(2000);
      const exit = await exitPromise;
      expect(exit.exitCode).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates non-zero exit code and sets providerFailureReason from stoppedReason', async () => {
    vi.useFakeTimers();
    try {
      const ecs = fakeEcs({
        DescribeTasksCommand: () => ({
          tasks: [
            {
              lastStatus: 'STOPPED',
              startedAt: new Date('2026-05-21T10:00:00.000Z'),
              stoppedAt: new Date('2026-05-21T10:00:02.000Z'),
              stopCode: 'TaskFailedToStart',
              stoppedReason: 'CannotPullContainerError: pull access denied',
              containers: [{ name: 'pangolin-worker', exitCode: 137 }],
            },
          ],
        }),
      });
      const provider = new FargateProvider(baseOpts({ ecsClient: ecs, pollIntervalMs: 10 }));

      const exitPromise = provider.awaitExit({ providerTaskId: 'arn:1' }, baseCtx);
      await vi.advanceTimersByTimeAsync(50);
      const exit = await exitPromise;

      expect(exit.exitCode).toBe(137);
      expect(exit.providerFailureReason).toMatch(/CannotPullContainerError/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats missing exitCode as -1 (provider failure before container started)', async () => {
    vi.useFakeTimers();
    try {
      const ecs = fakeEcs({
        DescribeTasksCommand: () => ({
          tasks: [
            {
              lastStatus: 'STOPPED',
              startedAt: new Date('2026-05-21T10:00:00.000Z'),
              stoppedAt: new Date('2026-05-21T10:00:01.000Z'),
              stoppedReason: 'CapacityProviderError',
              containers: [{ name: 'pangolin-worker' }],
            },
          ],
        }),
      });
      const provider = new FargateProvider(baseOpts({ ecsClient: ecs, pollIntervalMs: 10 }));

      const exitPromise = provider.awaitExit({ providerTaskId: 'arn:1' }, baseCtx);
      await vi.advanceTimersByTimeAsync(50);
      const exit = await exitPromise;

      expect(exit.exitCode).toBe(-1);
      expect(exit.providerFailureReason).toBe('CapacityProviderError');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('FargateProvider.cancel — StopTask', () => {
  it('calls StopTaskCommand with the configured cluster, task ARN, and reason "pangolin.cancel"', async () => {
    let captured: StopTaskCommand | null = null;
    const provider = new FargateProvider(
      baseOpts({
        cluster: 'prod-cluster',
        ecsClient: fakeEcs({
          StopTaskCommand: (cmd) => {
            captured = cmd as StopTaskCommand;
            return {};
          },
        }),
      }),
    );

    await provider.cancel({ providerTaskId: 'arn:aws:ecs:::task/abc' }, baseCtx);

    expect(captured).toBeInstanceOf(StopTaskCommand);
    expect(captured!.input.cluster).toBe('prod-cluster');
    expect(captured!.input.task).toBe('arn:aws:ecs:::task/abc');
    expect(captured!.input.reason).toBe('pangolin.cancel');
  });
});

describe('FargateProvider — ECS client injection', () => {
  it('uses the injected client rather than constructing a new ECSClient', async () => {
    const ecs = fakeEcs({
      RunTaskCommand: () => ({ tasks: [{ taskArn: 'arn:1' }] }),
    });
    const provider = new FargateProvider(baseOpts({ ecsClient: ecs }));
    await provider.run(baseSpec(), baseCtx);
    expect((ecs.send as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });
});
