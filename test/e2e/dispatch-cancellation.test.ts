// E2E §7.6: `client.dispatch.cancel(dispatchId)` stops a long-running
// dispatch via the provider's SIGTERM path within the grace period.
//
// The §7.6 contract is best-effort + idempotent:
//   - cancelling an in-flight dispatch routes SIGTERM into the provider,
//     which escalates to SIGKILL after `sigtermGraceSeconds`. The dispatch
//     promise resolves with `result.failure.reason === 'cancelled'`.
//   - cancelling an unknown dispatchId is a silent no-op (returns
//     `undefined`) — no record means nothing to cancel.
//   - re-cancelling a dispatch that already terminated is also a silent
//     no-op (the provider's `cancel()` swallows "container already
//     stopped" errors so callers can re-fire without coordinating state).
//
// We spawn a worker whose `pangolin-setup.sh` does `sleep 600`, wait long
// enough for the container to enter setup-script execution, then call
// `client.dispatch.cancel(...)`. The provider's grace period is dialled
// down to 5s so the test stays under its `60_000` ms vitest budget; the
// assertion gives an extra 2s slack on top of that.
//
// The suite SKIPS gracefully when the Docker daemon isn't reachable (same
// gate the rest of the E2E Docker suite uses). When it does run, storage
// uses a per-test `mkdtemp` directory via `useTempStorageRoot` so prior
// runs can't pollute content-hash invariants.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect } from 'vitest';
import { makeClient } from './helpers/make-client.js';
import { probeDocker, itIfDocker } from './helpers/docker-skip.js';
import { useTempStorageRoot } from './helpers/temp-storage.js';
import { WORKER_IMAGE } from './helpers/worker-image.js';

probeDocker();
const storageRoot = useTempStorageRoot('e2e-cancel');

describe('E2E: dispatch cancellation (§7.6)', () => {
  itIfDocker(
    'cancel during execution stops the worker within the grace period and surfaces failure.reason="cancelled"',
    async () => {
      const graceSeconds = 5;
      const client = makeClient({
        namespace: 'cancel',
        storageRoot: storageRoot(),
        // Shorten the grace window so the test does not eat its full
        // vitest timeout when the worker fails to honour SIGTERM and the
        // provider has to escalate to SIGKILL.
        dockerOpts: { sigtermGraceSeconds: graceSeconds },
      });

      const cap = await client.capabilities.register({
        name: 'long-run',
        // `sleep 600` is the deliberately-blocking workload. The worker
        // runs this via the §6.3 setup-script step; the only way it ever
        // exits within the test window is via the provider's SIGTERM →
        // SIGKILL cancel path.
        files: { 'pangolin-setup.sh': '#!/bin/sh\nsleep 600\n' },
      });
      await client.subagent.register({
        name: 'long',
        systemPrompt: 'noop',
        capabilities: [cap],
      });
      await client.env.register({ name: 'e', values: {} });

      // Fire the dispatch but DO NOT await it yet — we need a live
      // in-flight handle to cancel against. The promise will resolve
      // (with a `failure.reason === 'cancelled'` result) once the
      // provider's SIGTERM/SIGKILL path tears the container down.
      const dispatchPromise = client.dispatch({
        subagent: 'long',
        env: 'e',
        target: 'local',
        dispatchId: 'cancel-test-1',
        workerImage: WORKER_IMAGE,
      } as any);

      // Wait for the worker to be inside `sleep 600`. The 3s sleep is a
      // best-effort margin: container create + worker boot + bundle
      // fetch + overlay + setup-script spawn fits comfortably in that
      // window on a warm daemon.
      await new Promise((r) => setTimeout(r, 3000));

      const cancelStartedAt = Date.now();
      await client.dispatch.cancel('cancel-test-1');
      const result = await dispatchPromise;
      const cancelElapsedMs = Date.now() - cancelStartedAt;

      // §7.6: failure.reason must be the canonical 'cancelled' token so
      // downstream consumers (sinks, lifecycle subscribers, the CLI's
      // `pangolin describe`) can switch on it.
      expect(result.failure?.reason).toBe('cancelled');

      // The provider must honour the grace window: SIGTERM first, then
      // SIGKILL at `graceSeconds`. We allow 2s of slack on top of the
      // configured grace for daemon round-trips and inspect-poll cadence.
      expect(cancelElapsedMs).toBeLessThan((graceSeconds + 2) * 1000);
    },
    60_000,
  );

  itIfDocker(
    'cancel during execution emits dispatch.cancelled to the callback URL with the matching dispatchId',
    async () => {
      // §7.6 contract: "The worker traps SIGTERM, attempts to emit
      // `dispatch.cancelled`, releases channel subscriptions, and exits."
      // We verify the lifecycle event itself (not just `failure.reason`) by
      // standing up a local HTTP listener, configuring the dispatch's
      // `callback.url` to point at it, and asserting the captured POSTs
      // include a `dispatch.cancelled` event tagged with our dispatchId.
      // This mirrors the callback-signing-roundtrip.test.ts pattern.
      const received: Array<{ body: string }> = [];
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          received.push({ body });
          res.statusCode = 200;
          res.end('ok');
        });
      });
      // Bind to all interfaces on an OS-assigned port so the worker
      // container can reach us via host.docker.internal. Binding to
      // 127.0.0.1 would be unreachable from inside the container.
      await new Promise<void>((resolve) =>
        server.listen(0, '0.0.0.0', resolve),
      );

      try {
        const port = (server.address() as AddressInfo).port;
        // host.docker.internal resolves to the host on Docker Desktop
        // (Windows / Mac) automatically. Linux requires an
        // `extra_hosts: host-gateway` mapping the local-docker provider
        // does not currently configure — see callback-signing-roundtrip's
        // file header for why that's an accepted skip on Linux for now.
        const callbackUrl = `http://host.docker.internal:${port}/cb`;

        const graceSeconds = 5;
        const client = makeClient({
          namespace: 'cancel-emit',
          storageRoot: storageRoot(),
          dockerOpts: { sigtermGraceSeconds: graceSeconds },
        });

        const cap = await client.capabilities.register({
          name: 'long-run-emit',
          files: { 'pangolin-setup.sh': '#!/bin/sh\nsleep 600\n' },
        });
        await client.subagent.register({
          name: 'long-emit',
          systemPrompt: 'noop',
          capabilities: [cap],
        });
        await client.env.register({ name: 'e', values: {} });

        const dispatchId = `cancel-emit-${Date.now()}`;
        const dispatchPromise = client.dispatch({
          subagent: 'long-emit',
          env: 'e',
          target: 'local',
          dispatchId,
          callback: { url: callbackUrl, signatureAlgorithm: 'sha256' },
          workerImage: WORKER_IMAGE,
        } as never);

        // Wait for the worker to be inside `sleep 600` (and to have already
        // POSTed `dispatch.started`) before issuing cancel.
        await new Promise((r) => setTimeout(r, 3000));

        await client.dispatch.cancel(dispatchId);
        const result = await dispatchPromise;

        // Sanity: the cancel path resolved as expected (same as the
        // primary §7.6 case).
        expect(result.failure?.reason).toBe('cancelled');

        // The worker must have emitted a `dispatch.cancelled` lifecycle
        // event tagged with this dispatchId. We look at the bodies of
        // every captured POST and assert one has the canonical shape.
        const parsed = received.map((p) => {
          try {
            return JSON.parse(p.body) as { kind?: string; dispatchId?: string };
          } catch {
            return {} as { kind?: string; dispatchId?: string };
          }
        });
        const cancelledEvent = parsed.find(
          (ev) => ev.kind === 'dispatch.cancelled' && ev.dispatchId === dispatchId,
        );
        expect(cancelledEvent).toBeDefined();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    60_000,
  );

  itIfDocker(
    'cancel on a non-existent dispatchId is a silent no-op',
    async () => {
      const client = makeClient({
        namespace: 'cancel-noop',
        storageRoot: storageRoot(),
      });
      // No dispatch was ever run under this id, so there's no record to
      // resolve and nothing to cancel. The §7.6 contract collapses this
      // to `undefined` rather than surfacing the missing record as an
      // error — callers can re-fire cancel without coordinating state.
      await expect(
        client.dispatch.cancel('nonexistent-dispatch-id'),
      ).resolves.toBeUndefined();
    },
  );

  itIfDocker(
    'second cancel on the same dispatchId is idempotent (no throw)',
    async () => {
      const graceSeconds = 5;
      const client = makeClient({
        namespace: 'cancel-idem',
        storageRoot: storageRoot(),
        dockerOpts: { sigtermGraceSeconds: graceSeconds },
      });

      const cap = await client.capabilities.register({
        name: 'long-run-idem',
        files: { 'pangolin-setup.sh': '#!/bin/sh\nsleep 600\n' },
      });
      await client.subagent.register({
        name: 'long-idem',
        systemPrompt: 'noop',
        capabilities: [cap],
      });
      await client.env.register({ name: 'e', values: {} });

      const dispatchPromise = client.dispatch({
        subagent: 'long-idem',
        env: 'e',
        target: 'local',
        dispatchId: 'cancel-test-idem',
        workerImage: WORKER_IMAGE,
      } as any);

      await new Promise((r) => setTimeout(r, 3000));

      // First cancel — drives the live container through SIGTERM /
      // SIGKILL and resolves the dispatch promise.
      await client.dispatch.cancel('cancel-test-idem');
      const result = await dispatchPromise;
      expect(result.failure?.reason).toBe('cancelled');

      // Second cancel against the now-terminal dispatch. The provider's
      // `cancel()` already swallows "container already stopped" errors
      // (see LocalDockerProvider.cancel), so this must resolve cleanly
      // with `undefined` rather than throwing.
      await expect(
        client.dispatch.cancel('cancel-test-idem'),
      ).resolves.toBeUndefined();
    },
    60_000,
  );
});
