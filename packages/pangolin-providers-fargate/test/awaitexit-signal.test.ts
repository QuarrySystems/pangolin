import { describe, it, expect, vi } from 'vitest';
import { FargateProvider, type FargateProviderOpts } from '../src/index.js';
import { type ProviderContext } from '@quarry-systems/pangolin-core';
import { DescribeTasksCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import type { ECSClient } from '@aws-sdk/client-ecs';

const baseOpts = (overrides: Partial<FargateProviderOpts> = {}): FargateProviderOpts => ({
  cluster: 'c',
  taskDefinitionFamily: 'pangolin-worker',
  subnets: ['subnet-1'],
  securityGroups: ['sg-1'],
  ...overrides,
});

describe('FargateProvider.awaitExit — ctx.signal abort', () => {
  it('aborts the poll, StopTasks, and returns a timeout exit when ctx.signal fires', async () => {
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof DescribeTasksCommand) {
        return { tasks: [{ lastStatus: 'PROVISIONING', containers: [] }] };
      }
      return {}; // StopTask
    });

    const provider = new FargateProvider(
      baseOpts({
        ecsClient: { send } as unknown as ECSClient,
        pollIntervalMs: 5,
      }),
    );

    const ac = new AbortController();
    const ctx: ProviderContext = { credentials: { kind: 'none' }, signal: ac.signal };

    const p = provider.awaitExit({ providerTaskId: 'arn:task/1' }, ctx);
    setTimeout(() => ac.abort(), 20);

    const exit = await p;

    expect(exit.providerFailureReason).toBe('timeout');
    expect(exit.exitCode).toBe(-1);
    expect(send.mock.calls.some(([c]) => c instanceof StopTaskCommand)).toBe(true);
  });
});
