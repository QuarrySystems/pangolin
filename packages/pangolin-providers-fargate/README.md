# -systems/pangolin-providers-fargate

A `ComputeProvider` implementation backed by AWS ECS Fargate. `run()` calls `RunTask` on a pre-configured task-definition family, overriding the container's environment, command, and resources per the inbound `TaskSpec`. `awaitExit()` polls `DescribeTasks` until the task reaches the `STOPPED` lifecycle state, then projects the task metadata into a `TaskExit`. `cancel()` calls `StopTask` with the `pangolin.cancel` reason marker; ECS handles the SIGTERM/SIGKILL grace dance per the task definition's `stopTimeout`. Image references must be digest-pinned (`image@sha256:...`) unless the caller opts in via `allowUnpinnedImage: true` for dev iteration.

## Install

```bash
pnpm add -systems/pangolin-providers-fargate
```

## Basic usage

```typescript
import { PangolinClient } from '-systems/pangolin-client';
import { FargateProvider } from '-systems/pangolin-providers-fargate';

const fargate = new FargateProvider({
  cluster: 'arn:aws:ecs:us-east-1:123:cluster/pangolin',
  taskDefinitionFamily: 'pangolin-worker',
  subnets: ['subnet-abc123'],
  securityGroups: ['sg-def456'],
});

const client = new PangolinClient({
  namespace: 'my-org',
  compute: { fargate },
  // ...
});
```

Secret refs on the inbound `TaskSpec` must be pre-declared in the task definition's `secrets:[]` block — ECS does not permit injecting new secrets at RunTask time.

## Spec

- [§5 Pluggable interfaces](https://github.com/QuarrySystems/pangolin/blob/main/docs/superpowers/specs/2026-05-21-agora-mvp-design.md#5-pluggable-interfaces) — the `ComputeProvider` contract this package implements.
- [§7.4 Image pinning](https://github.com/QuarrySystems/pangolin/blob/main/docs/superpowers/specs/2026-05-21-agora-mvp-design.md#74-image-pinning) — the digest-pin requirement this provider enforces.

## Decisions

- [ADR-0001 — Package scope](https://quarrysystems.github.io/pangolin/explanation/decisions/0001-package-scope/): the `@quarry-systems/pangolin-*` namespace this package publishes under.
- [ADR-0016 — Cancel in MVP](https://quarrysystems.github.io/pangolin/explanation/decisions/0016-cancel-in-mvp/): the best-effort cancellation contract this provider satisfies via `StopTask`.
