// E2E: notification fanout (ADR-002 / decision 0012).
//
// Verifies that BOTH notification sources defined by decision-0012 fire
// correctly end-to-end through a real local-docker dispatch:
//
//   1. Capability-content notifications — a `pangolin-notifications.json` file
//      packaged inside the capability bundle. The worker's
//      `loadCapabilityNotifications` reads it post-overlay (entrypoint
//      step 11).
//   2. Dispatch-level notifications — the `notifications: NotificationConfig[]`
//      array supplied on `DispatchWork`. The worker merges this with the
//      capability source at fire time in `fireNotifications`.
//
// Both sources flow through the SAME HMAC-signing path as `signCallback`
// (§7.3): hex HMAC-SHA256 over `${dispatchId}.${timestamp}.${payload}`,
// keyed by the per-dispatch HMAC secret minted in Secrets Manager. The
// notifications subsystem currently shares the callback HMAC key — see
// `entrypoint.ts` step 4, which populates `hmacKeyForNotifications` ONLY
// when a callback URL is configured. We configure a callback here too so
// the test exercises the realistic wiring (PagerDuty / Slack subscribers
// need signed payloads; in production a callback is virtually always set
// alongside notifications).
//
// We stand up a local HTTP listener that captures POSTs to two distinct
// paths (`/cap-source` and `/dispatch-source`) so we can tell which
// source produced each POST. Capability-content notifications point at
// `/cap-source`; dispatch-level notifications point at `/dispatch-source`.
// On the happy path we expect at least one POST to each path on
// `dispatch.finished`.
//
// Container-reach-to-host: the worker POSTs to
// `http://host.docker.internal:<port>/...`. On Docker Desktop
// (Windows + Mac) this resolves automatically. On native Linux it
// requires `extra_hosts: host.docker.internal:host-gateway` on the
// container, which `LocalDockerProvider` does not currently wire — so on
// Linux CI this test will register as itIfDocker but the inner POSTs
// will simply never arrive, identical to the callback-signing-roundtrip
// test's documented Linux gap.
//
// The suite SKIPS gracefully when the Docker daemon isn't reachable, the
// same gate every Docker-using E2E suite uses.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { describe, expect, beforeEach, afterEach } from 'vitest';

import { makeClient } from './helpers/make-client.js';
import { probeDocker, itIfDocker } from './helpers/docker-skip.js';
import { useTempStorageRoot } from './helpers/temp-storage.js';
import { WORKER_IMAGE } from './helpers/worker-image.js';

probeDocker();
const storageRoot = useTempStorageRoot('e2e-notify');

interface CapturedPost {
  path: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
let received: CapturedPost[] = [];

beforeEach(() => {
  received = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ path: req.url, headers: req.headers, body });
      res.statusCode = 200;
      res.end('ok');
    });
  });
  // Bind 0.0.0.0 (not 127.0.0.1) so the worker container can reach us via
  // host.docker.internal.
  return new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
});

afterEach(() => {
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('E2E: notification fanout (decision-0012)', () => {
  itIfDocker(
    'both capability-content and dispatch-level notifications fire on dispatch.finished with HMAC-signed POSTs',
    async () => {
      const port = (server.address() as AddressInfo).port;
      const capSourceUrl = `http://host.docker.internal:${port}/cap-source`;
      const dispatchSourceUrl = `http://host.docker.internal:${port}/dispatch-source`;
      // The callback URL is configured so that the worker mints + resolves
      // the HMAC key the notifications subsystem reuses. POSTs to this path
      // are the lifecycle stream and are NOT the assertion target — we
      // assert on /cap-source and /dispatch-source. We capture them anyway
      // so a regression that conflates the two surfaces is easier to spot
      // in the test failure output.
      const callbackUrl = `http://host.docker.internal:${port}/cb`;

      const client = makeClient({
        namespace: 'notify',
        storageRoot: storageRoot(),
      });

      // Capability bundle ships a `pangolin-notifications.json` declaring a
      // capability-content webhook subscribed to `dispatch.finished`. This is
      // the bytes-on-disk source that `loadCapabilityNotifications` parses
      // post-overlay.
      const cap = await client.capabilities.register({
        name: 'with-notif',
        files: {
          'pangolin-setup.sh': '#!/bin/sh\necho "setup ran"\n',
          'pangolin-notifications.json': JSON.stringify([
            { when: ['dispatch.finished'], webhook: capSourceUrl },
          ]),
        },
      });
      await client.subagent.register({
        name: 'noop',
        systemPrompt: 'exit immediately.',
        capabilities: [cap],
      });
      await client.env.register({ name: 'e', values: {} });

      // Deterministic dispatchId so we can correlate the X-Pangolin-Dispatch-Id
      // header on captured POSTs back to the dispatch under test and so the
      // Secrets Manager lookup for the HMAC key is fully predictable.
      const dispatchId = `e2e-notify-${Date.now()}`;

      const result = await client.dispatch({
        subagent: 'noop',
        env: 'e',
        target: 'local',
        dispatchId,
        callback: { url: callbackUrl, signatureAlgorithm: 'sha256' },
        notifications: [
          { when: ['dispatch.finished'], webhook: dispatchSourceUrl },
        ],
        timeoutSeconds: 60,
        workerImage: WORKER_IMAGE,
      } as never);

      expect(result.exitCode).toBe(0);
      expect(result.dispatchId).toBe(dispatchId);

      // Partition captured POSTs by path. The capability-content webhook
      // hits /cap-source; the dispatch-level webhook hits /dispatch-source.
      // Lifecycle events hit /cb (we don't assert on those here — the
      // callback-signing-roundtrip test covers that surface).
      const capPosts = received.filter((r) => r.path === '/cap-source');
      const dispatchPosts = received.filter((r) => r.path === '/dispatch-source');

      // Acceptance criterion 1: capability-content notification fires.
      expect(capPosts.length).toBeGreaterThanOrEqual(1);
      // Acceptance criterion 2: dispatch-level notification fires.
      expect(dispatchPosts.length).toBeGreaterThanOrEqual(1);

      // Acceptance criterion 3: both POSTs carry HMAC headers that verify
      // against the per-dispatch key the worker fetched from Secrets
      // Manager. We resolve the same secret via the same ARN convention
      // `mintCallbackHmac` uses (`pangolin/callback-hmac/<dispatchId>`) and
      // re-compute the signature.
      const { SecretsManagerClient, GetSecretValueCommand } = await import(
        '@aws-sdk/client-secrets-manager'
      );
      const secretsClient = new SecretsManagerClient({});
      const secretRes = await secretsClient.send(
        new GetSecretValueCommand({
          SecretId: `pangolin/callback-hmac/${dispatchId}`,
        }),
      );
      const hmacKey = secretRes.SecretString;
      if (!hmacKey) {
        throw new Error(
          `expected SecretString for dispatch ${dispatchId} but got none`,
        );
      }

      const verifyPost = (post: CapturedPost): void => {
        const sig = post.headers['x-pangolin-signature'];
        const ts = post.headers['x-pangolin-timestamp'];
        const seenId = post.headers['x-pangolin-dispatch-id'];
        expect(typeof sig).toBe('string');
        expect(typeof ts).toBe('string');
        expect(seenId).toBe(dispatchId);

        const expected = createHmac('sha256', hmacKey)
          .update(`${dispatchId}.${ts as string}.${post.body}`)
          .digest('hex');
        expect(sig).toBe(`sha256=${expected}`);

        // Body must parse as a LifecycleEvent JSON object whose dispatchId
        // matches and whose kind is one of the closed-taxonomy values.
        const parsed = JSON.parse(post.body) as {
          dispatchId?: string;
          kind?: string;
        };
        expect(parsed.dispatchId).toBe(dispatchId);
        expect(parsed.kind).toBe('dispatch.finished');
      };

      for (const p of capPosts) verifyPost(p);
      for (const p of dispatchPosts) verifyPost(p);
    },
    180_000,
  );

  itIfDocker(
    'notification with non-matching when filter does NOT fire on wrong event kind',
    async () => {
      const port = (server.address() as AddressInfo).port;
      // Both sources subscribe to `dispatch.failed` ONLY. The happy-path
      // dispatch emits `dispatch.started` + `dispatch.finished`, neither of
      // which matches — so neither source should produce a POST.
      const capSourceUrl = `http://host.docker.internal:${port}/cap-source-no-fire`;
      const dispatchSourceUrl = `http://host.docker.internal:${port}/dispatch-source-no-fire`;
      // We deliberately omit `callback` here. With no callback URL,
      // `hmacKeyForNotifications` stays empty in the worker — so even if a
      // notification's `when` filter DID match, the firing path would be
      // exercised. The point of this test is the filter: no match → no
      // POST, regardless of the HMAC key state.

      const client = makeClient({
        namespace: 'notify-filter',
        storageRoot: storageRoot(),
      });

      const cap = await client.capabilities.register({
        name: 'with-failed-notif',
        files: {
          'pangolin-setup.sh': '#!/bin/sh\necho "setup ran"\n',
          'pangolin-notifications.json': JSON.stringify([
            { when: ['dispatch.failed'], webhook: capSourceUrl },
          ]),
        },
      });
      await client.subagent.register({
        name: 'noop-filter',
        systemPrompt: 'exit immediately.',
        capabilities: [cap],
      });
      await client.env.register({ name: 'ef', values: {} });

      const result = await client.dispatch({
        subagent: 'noop-filter',
        env: 'ef',
        target: 'local',
        notifications: [
          { when: ['dispatch.failed'], webhook: dispatchSourceUrl },
        ],
        timeoutSeconds: 60,
        workerImage: WORKER_IMAGE,
      } as never);

      // Sanity: the dispatch must SUCCEED (so the lifecycle stream emits
      // `dispatch.finished`, NOT `dispatch.failed`). If the dispatch
      // failed for some unrelated reason, the test would pass vacuously —
      // every notification's `when: ['dispatch.failed']` would (mis-)match.
      expect(result.exitCode).toBe(0);

      const capPosts = received.filter((r) => r.path === '/cap-source-no-fire');
      const dispatchPosts = received.filter(
        (r) => r.path === '/dispatch-source-no-fire',
      );

      // Acceptance criterion 4: non-matching `when` filter does NOT fire.
      // Both sources subscribe to `dispatch.failed`; the dispatch finished
      // successfully. Therefore zero POSTs on either path.
      expect(capPosts).toHaveLength(0);
      expect(dispatchPosts).toHaveLength(0);
    },
    120_000,
  );
});
