# -systems/pangolin-providers-aws-creds

A `CredentialProvider` implementation that wraps the AWS SDK's default credential chain (environment variables, shared credentials file, container IAM role, EC2 instance metadata) and projects the resolved credentials into a `ResolvedCredentials` discriminated with `kind: 'aws'`. No caching beyond what the underlying chain itself performs; integrators wanting cross-process caching wire their own resolver via `providerOverride`. Construction is side-effect-free — the chain is invoked lazily on each `resolve()` call so any SDK I/O happens at resolution time, not at client construction.

## Install

```bash
pnpm add -systems/pangolin-providers-aws-creds
```

## Basic usage

```typescript
import { PangolinClient } from '-systems/pangolin-client';
import { AwsCredentialProvider } from '-systems/pangolin-providers-aws-creds';

const client = new PangolinClient({
  namespace: 'my-org',
  credentials: { aws: new AwsCredentialProvider() },
  // ...
});
```

For assume-role flows or other custom credential sources that don't fit the default chain, pass `providerOverride:`:

```typescript
new AwsCredentialProvider({
  providerOverride: async () => assumeRoleAndReturnCreds(),
});
```

## Spec

- [§5 Pluggable interfaces](../../docs/superpowers/specs/2026-05-21-pangolin-mvp-design.md#5-pluggable-interfaces) — the `CredentialProvider` contract this package implements.
- [§7.5 Storage IAM](../../docs/superpowers/specs/2026-05-21-pangolin-mvp-design.md#75-storage-iam) — the IAM boundary this provider operates within.

## Decisions

- [ADR-0001 — Package scope](../../docs/decisions/0001-package-scope.md): the `@quarry-systems/pangolin-*` namespace this package publishes under.
- [ADR-0007 — Inline secret TTL auto-computed](../../docs/decisions/0007-inline-secret-ttl-auto-computed.md): the secrets lifecycle this credential provider supports for Secrets Manager access.
