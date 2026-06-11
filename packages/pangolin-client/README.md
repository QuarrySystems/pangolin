# -systems/pangolin-client

The caller-side SDK for the pangolin dispatch system. `PangolinClient` is the single entry point integrators construct in their deploy code: it holds the wired-in compute, credential, and storage providers, exposes the deploy-time `capabilities.register()` / `subagent.register()` / `env.register()` surface, and exposes the run-time `dispatch()`, `dispatch.describe()`, and `dispatch.cancel()` surface against the same registry. Privileged registration runs from a human at a terminal or a deploy pipeline; dispatch runs from anything that holds a client instance, including the MCP server.

## Install

```bash
pnpm add -systems/pangolin-client
```

## Basic usage

```typescript
import { PangolinClient } from '-systems/pangolin-client';
import { FargateProvider } from '-systems/pangolin-providers-fargate';
import { AwsCredentialProvider } from '-systems/pangolin-providers-aws-creds';
import { S3StorageProvider } from '-systems/pangolin-storage-s3';

const client = new PangolinClient({
  namespace: 'my-org',
  compute: { fargate: new FargateProvider({ /* ... */ }) },
  credentials: { aws: new AwsCredentialProvider() },
  storage: new S3StorageProvider({ bucket: 'my-org-pangolin-artifacts' }),
  targets: { 'fargate-prod': { compute: 'fargate', credentials: 'aws' } },
});

const result = await client.dispatch({
  subagent: 'code-reviewer',
  env: 'prod',
  input: { repoUrl: 'https://github.com/my-org/repo', issueId: 123 },
  target: 'fargate-prod',
});
```

The full registration flow (`capabilities.register`, `subagent.register`, `subagent.assign`, `env.register`) is documented in the spec's worked Hello World.

## Spec

- [§3 Architecture overview](../../docs/superpowers/specs/2026-05-21-pangolin-mvp-design.md#3-architecture-overview) — where the client sits in the system.
- [§4 Caller API](../../docs/superpowers/specs/2026-05-21-pangolin-mvp-design.md#4-caller-api) — the deploy-time and run-time surfaces this package implements.

## Decisions

- [ADR-0001 — Package scope](../../docs/decisions/0001-package-scope.md): the `@quarry-systems/pangolin-*` namespace this package publishes under.
- [ADR-0012 — Notifications dual-home](../../docs/decisions/0012-notifications-dual-home.md): why notification config lives on both capability content and the dispatch field.
- [ADR-0013 — MVP single namespace](../../docs/decisions/0013-mvp-single-namespace.md): the registry boundary the client targets.
