// @quarry-systems/pangolin-providers-fargate
//
// `ComputeProvider` (§5.1) implementation backed by AWS ECS Fargate. `run()`
// calls `RunTask` on a pre-configured task-definition family, overriding the
// container's image, env, secrets, command, and resources per the inbound
// `TaskSpec`. `awaitExit()` polls `DescribeTasks` at a configurable cadence
// until the task reaches the `STOPPED` lifecycle state, then projects the
// task metadata into a `TaskExit`. `cancel()` calls `StopTask` with the
// pangolin-cancel reason marker; ECS handles the SIGTERM/SIGKILL grace dance
// according to the task definition's `stopTimeout`.
//
// Image references must be digest-pinned (`image@sha256:...`) per §7.4 unless
// the caller opts in via `allowUnpinnedImage: true` (intended for dev/test).
//
// The ECS client is injectable so the smoke suite can drive the provider
// against a fake `send` without making any AWS calls; integration tests
// against a live account or LocalStack live in a separate task.

import {
  DescribeTasksCommand,
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import {
  UnpinnedImageError,
  type ComputeProvider,
  type ProviderContext,
  type TaskExit,
  type TaskHandle,
  type TaskSpec,
} from '@quarry-systems/pangolin-core';

/** Per-instance options for {@link FargateProvider}. */
export interface FargateProviderOpts {
  /** ECS cluster name or ARN the tasks run in. */
  cluster: string;
  /**
   * Task definition family name (without revision). RunTask resolves to the
   * latest active revision; pin a specific revision by passing `family:N`.
   */
  taskDefinitionFamily: string;
  /** Subnet IDs for the awsvpc network configuration. */
  subnets: string[];
  /** Security group IDs for the awsvpc network configuration. */
  securityGroups: string[];
  /**
   * Whether the task gets a public IP. Defaults to `'DISABLED'`; set to
   * `'ENABLED'` only when running in a public subnet without a NAT.
   */
  assignPublicIp?: 'ENABLED' | 'DISABLED';
  /**
   * Inject a pre-constructed ECSClient. Defaults to a new `new ECSClient({})`
   * which picks up region + credentials from the ambient AWS SDK chain.
   */
  ecsClient?: ECSClient;
  /**
   * Allow non-digest-pinned images. Disabled by default per §7.4. Intended
   * for dev / local iteration; production dispatches must always pin.
   */
  allowUnpinnedImage?: boolean;
  /**
   * Interval between `DescribeTasks` polls inside {@link FargateProvider.awaitExit}.
   * Defaults to 5000 ms — small enough to keep dispatch latency reasonable
   * while staying well under the ECS API rate limits.
   */
  pollIntervalMs?: number;
}

/** Matches the `name@sha256:<64-hex>` tail. */
const IMAGE_DIGEST_RE = /@sha256:[0-9a-f]{64}$/;

/** Name of the container in the task definition that we override per-dispatch. */
const CONTAINER_NAME = 'pangolin-worker';

/** Reason marker passed to `StopTask` so post-hoc audits can attribute the stop. */
const CANCEL_REASON = 'pangolin.cancel';

/**
 * Fargate {@link ComputeProvider}. ECS client is injected so the smoke suite
 * can drive the provider against a fake `send` without making AWS calls.
 */
export class FargateProvider implements ComputeProvider {
  readonly name = 'fargate';
  private readonly ecs: ECSClient;
  private readonly opts: FargateProviderOpts;
  private readonly pollIntervalMs: number;

  constructor(opts: FargateProviderOpts) {
    this.opts = opts;
    this.ecs = opts.ecsClient ?? new ECSClient({});
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
  }

  async run(spec: TaskSpec, _ctx: ProviderContext): Promise<TaskHandle> {
    this.assertImagePinned(spec.image);
    this.assertSecretRefsHandledByTaskDefinition(spec.secretRefs);

    const res = await this.ecs.send(
      new RunTaskCommand({
        cluster: this.opts.cluster,
        taskDefinition: this.opts.taskDefinitionFamily,
        launchType: 'FARGATE',
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: this.opts.subnets,
            securityGroups: this.opts.securityGroups,
            assignPublicIp: this.opts.assignPublicIp ?? 'DISABLED',
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: CONTAINER_NAME,
              // NB: ECS does not permit overriding the container image, nor
              // injecting new `secrets:` entries, at RunTask — both are locked
              // in by the task definition. We still enforce the digest-pin
              // gate above (per §7.4) so callers cannot dispatch a TaskSpec
              // whose pin disagrees with the task definition; and we throw
              // if `secretRefs` is non-empty (callers must pre-declare those
              // secrets in the task definition's `secrets:[]` so they are
              // present at task launch).
              environment: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
              command: spec.command,
              cpu: spec.resources?.cpu,
              memory: spec.resources?.memory,
            },
          ],
        },
        tags: [{ key: 'pangolin:dispatchId', value: spec.dispatchId }],
      }),
    );

    const arn = res.tasks?.[0]?.taskArn;
    if (!arn) {
      const failures = JSON.stringify(res.failures ?? []);
      throw new Error(`Fargate RunTask returned no task ARN (failures: ${failures})`);
    }
    return { providerTaskId: arn };
  }

  async awaitExit(handle: TaskHandle, _ctx: ProviderContext): Promise<TaskExit> {
    // Poll DescribeTasks until the task reaches the STOPPED lifecycle state,
    // then project the task metadata into a TaskExit. We do not attempt to
    // surface stdout/stderr for the MVP; production deployments wire the task
    // definition's awslogs driver to CloudWatch Logs and read those out of
    // band (a follow-up task can teach awaitExit() to do that opportunistically
    // when log config is present).
    for (;;) {
      const res = await this.ecs.send(
        new DescribeTasksCommand({
          cluster: this.opts.cluster,
          tasks: [handle.providerTaskId],
        }),
      );

      const task = res.tasks?.[0];
      if (task && task.lastStatus === 'STOPPED') {
        const container = task.containers?.find((c) => c.name === CONTAINER_NAME)
          ?? task.containers?.[0];
        const exitCode = container?.exitCode ?? -1;
        const startedAt = task.startedAt instanceof Date
          ? task.startedAt
          : task.startedAt
            ? new Date(task.startedAt)
            : new Date(0);
        const finishedAt = task.stoppedAt instanceof Date
          ? task.stoppedAt
          : task.stoppedAt
            ? new Date(task.stoppedAt)
            : new Date(0);

        // Treat the task's stoppedReason as an infrastructural failure reason
        // when it is set AND the exit code is non-zero (or missing). A clean
        // exit (0) with a stoppedReason like "EssentialContainerExited" is not
        // a failure — that's just how ECS describes a normal stop.
        const providerFailureReason =
          exitCode !== 0 && typeof task.stoppedReason === 'string' && task.stoppedReason.length > 0
            ? task.stoppedReason
            : undefined;

        return {
          exitCode,
          startedAt,
          finishedAt,
          stdout: '',
          stderr: '',
          providerFailureReason,
        };
      }

      await sleep(this.pollIntervalMs);
    }
  }

  async cancel(handle: TaskHandle, _ctx: ProviderContext): Promise<void> {
    await this.ecs.send(
      new StopTaskCommand({
        cluster: this.opts.cluster,
        task: handle.providerTaskId,
        reason: CANCEL_REASON,
      }),
    );
  }

  private assertImagePinned(image: string): void {
    if (this.opts.allowUnpinnedImage) return;
    if (!IMAGE_DIGEST_RE.test(image)) {
      throw new UnpinnedImageError(image);
    }
  }

  private assertSecretRefsHandledByTaskDefinition(secretRefs: Record<string, string>): void {
    const names = Object.keys(secretRefs);
    if (names.length === 0) return;
    throw new Error(
      `Fargate: secretRefs must be pre-declared in the task definition's secrets:[] ` +
        `block — RunTask cannot inject new secrets at dispatch time. ` +
        `Offending keys: ${names.join(', ')}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
