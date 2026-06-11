# -systems/pangolin-worker

The container-side runtime that executes one dispatch invocation per process. The worker is runtime-agnostic: it parses its env, fetches and integrity-verifies capability/subagent/env bundles from storage, overlays them onto a fresh workspace, resolves secrets, runs `pangolin-setup.sh` if present, subscribes to the channel adapter, then hands off to the configured `RuntimeAdapter` (Claude Code by default) to do the actual model invocation. Lifecycle events fire to the configured callback URL throughout. Provider packages are never direct dependencies — they are composed at the deployment boundary.

## Install

```bash
pnpm add -systems/pangolin-worker
```

The published OCI image (`-systems/pangolin-worker`) bundles the worker plus the `pangolin-runtime-claude-code` adapter and is what `ComputeProvider.run()` typically launches. The npm package is for integrators building their own worker images.

## Basic usage

```typescript
import { runWorker, parseWorkerEnv } from '-systems/pangolin-worker';

// Inside the container CMD:
const config = parseWorkerEnv(process.env);
const exitCode = await runWorker(config);
process.exit(exitCode);
```

The worker reads `PANGOLIN_DISPATCH_ID`, `PANGOLIN_STORAGE_URI`, `PANGOLIN_CALLBACK_URL`, `PANGOLIN_RUNTIME_ADAPTER` (default `claude-code`), and the bundle refs from its environment. It produces `dispatch.finished` / `dispatch.failed` / `dispatch.needs_input` lifecycle events on the callback URL and exits with the runtime's exit code (or zero on a clean `needs_input`).

## Spec

- [§6 Worker contract](../../docs/superpowers/specs/2026-05-21-pangolin-mvp-design.md#6-worker-contract) — the lifecycle steps and runtime-agnostic boundaries this package implements.
- [§7.2 Bundle integrity](../../docs/superpowers/specs/2026-05-21-pangolin-mvp-design.md#72-bundle-integrity) — the content-hash verification gate that runs before any bundle is overlaid.

## Decisions

- [ADR-0003 — Runtime adapter seam at MVP](../../docs/decisions/0003-runtime-adapter-seam-at-mvp.md): why the worker is runtime-agnostic and providers are injected, not bundled.
- [ADR-0004 — Lifecycle vocabulary closed at six](../../docs/decisions/0004-lifecycle-vocabulary-closed-at-six.md): the six event kinds this worker emits.
- [ADR-0008 — needs_input request-stop-restart](../../docs/decisions/0008-needs-input-request-stop-restart.md): how the worker handles a sub-agent asking for clarification.
- [ADR-0014 — Stdout cap](../../docs/decisions/0014-stdout-cap.md): the 4 MiB / 256 KiB caps the worker enforces on captured output.
