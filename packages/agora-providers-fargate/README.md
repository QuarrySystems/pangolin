# @quarry-systems/agora-providers-fargate

A `ComputeProvider` implementation backed by AWS ECS Fargate. `run()` calls `RunTask` on a pre-configured task-definition family, overriding the container's environment, command, and resources per the inbound `TaskSpec`. `awaitExit()` polls `DescribeTasks` until the task reaches the `STOPPED` lifecycle state, then projects the task metadata into a `TaskExit`. `cancel()` calls `StopTask` with the `agora.cancel` reason marker; ECS handles the SIGTERM/SIGKILL grace dance per the task definition's `stopTimeout`. Image references must be digest-pinned (`image@sha256:...`) unless the caller opts in via `allowUnpinnedImage: true` for dev iteration.

## Install

```bash
pnpm add @quarry-systems/agora-providers-fargate
```

## Basic usage

```typescript
import { AgoraClient } from '@quarry-systems/agora-client';
import { FargateProvider } from '@quarry-systems/agora-providers-fargate';

const fargate = new FargateProvider({
  cluster: 'arn:aws:ecs:us-east-1:123:cluster/agora',
  taskDefinitionFamily: 'agora-worker',
  subnets: ['subnet-abc123'],
  securityGroups: ['sg-def456'],
});

const client = new AgoraClient({
  namespace: 'my-org',
  compute: { fargate },
  // ...
});
```

Secret refs on the inbound `TaskSpec` must be pre-declared in the task definition's `secrets:[]` block — ECS does not permit injecting new secrets at RunTask time.

## Spec

- [§5 Pluggable interfaces](../../docs/superpowers/specs/2026-05-21-agora-mvp-design.md#5-pluggable-interfaces) — the `ComputeProvider` contract this package implements.
- [§7.4 Image pinning](../../docs/superpowers/specs/2026-05-21-agora-mvp-design.md#74-image-pinning) — the digest-pin requirement this provider enforces.

## Decisions

- [ADR-0001 — Package scope](../../docs/decisions/0001-package-scope.md): the `@quarry-systems/agora-*` namespace this package publishes under.
- [ADR-0016 — Cancel in MVP](../../docs/decisions/0016-cancel-in-mvp.md): the best-effort cancellation contract this provider satisfies via `StopTask`.
