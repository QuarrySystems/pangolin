# -systems/pangolin-providers-local-docker

A `ComputeProvider` implementation backed by the local Docker daemon via the `dockerode` client. `run()` creates and starts a container with the spec's image, environment, and command; `awaitExit()` blocks on Docker's wait API and demultiplexes stdout/stderr from the container log stream; `cancel()` sends SIGTERM with a configurable grace period and escalates to SIGKILL if the container has not stopped by then. Intended for developer iteration and the local end-to-end smoke suite — production deployments use the Fargate provider. Image references must be digest-pinned (`image@sha256:...`) unless the caller opts in via `allowUnpinnedImage: true` for dev iteration.

## Install

```bash
pnpm add -systems/pangolin-providers-local-docker
```

## Basic usage

```typescript
import { PangolinClient } from '-systems/pangolin-client';
import { LocalDockerProvider } from '-systems/pangolin-providers-local-docker';

const localDocker = new LocalDockerProvider({
  allowUnpinnedImage: true, // dev only
  sigtermGraceSeconds: 10,
});

const client = new PangolinClient({
  namespace: 'my-org',
  compute: { 'local-docker': localDocker },
  // ...
});
```

The provider talks to `/var/run/docker.sock` on Unix or `//./pipe/docker_engine` on Windows by default; pass `docker:` to inject a pre-configured Dockerode instance for remote daemons or tests.

## Spec

- [§5 Pluggable interfaces](../../docs/superpowers/specs/2026-05-21-pangolin-mvp-design.md#5-pluggable-interfaces) — the `ComputeProvider` contract this package implements.
- [§7.4 Image pinning](../../docs/superpowers/specs/2026-05-21-pangolin-mvp-design.md#74-image-pinning) — the digest-pin requirement this provider enforces by default.

## Decisions

- [ADR-0001 — Package scope](../../docs/decisions/0001-package-scope.md): the `@quarry-systems/pangolin-*` namespace this package publishes under.
- [ADR-0016 — Cancel in MVP](../../docs/decisions/0016-cancel-in-mvp.md): the SIGTERM-grace-SIGKILL contract this provider implements.
