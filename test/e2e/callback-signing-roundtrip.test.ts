// E2E §7.3: callback signing roundtrip.
//
// Verifies the §7.3 callback contract end-to-end:
//
//   1. The caller configures `work.callback.url`. `dispatchWork` (§6.2 step 4)
//      mints a per-dispatch HMAC key in Secrets Manager and propagates the
//      ARN to the worker via `PANGOLIN_CALLBACK_TOKEN_REF`.
//   2. The worker fetches the key (entrypoint step 4) and, for every
//      lifecycle event it emits, POSTs an HMAC-signed payload to the
//      configured callback URL. The signature scheme is hex HMAC-SHA256 over
//      `${dispatchId}.${timestampIso}.${payload}` (see
//      `packages/pangolin-client/src/callback-hmac.ts#signCallback`, which the
//      worker's `LifecycleEmitter` mirrors).
//   3. The integrator (this test) stands up a local HTTP listener,
//      captures the POSTs, re-computes the signature with the SAME key, and
//      asserts byte-for-byte equality. The exact code path the worker uses
//      to sign is re-used here via the `signCallback` export — proving the
//      symmetry property §7.3 promises.
//
// Replay-protection skew (§7.3): the spec requires the `X-Pangolin-Timestamp`
// header to be within 5 minutes of the verifier's wall clock. The
// roundtrip suite asserts this on every captured POST.
//
// The test SKIPS on machines without a Docker daemon (no `docker.ping()`),
// because it depends on the full local-docker compute path. It also depends
// on a reachable AWS Secrets Manager (real or LocalStack) — `mintCallbackHmac`
// stages the key there and the worker resolves it via `GetSecretValueCommand`.
// The same AWS dependency exists for the sibling local-docker happy-path
// test; when one is wired in CI, this one is too.
//
// Container-reach-to-host: the worker container POSTs to
// `http://host.docker.internal:<port>/cb`. On Docker Desktop (Windows + Mac)
// that DNS name resolves automatically. On native Linux it requires an
// `extra_hosts: host.docker.internal:host-gateway` entry on the container —
// the local-docker provider does not currently configure that, so on Linux
// CI the test will pass-as-skipped (the daemon is reachable, but the
// container can't reach the test process). That gap is documented here
// rather than worked around: callback wiring on Linux is a follow-up.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { describe, expect, beforeEach, afterEach } from 'vitest';

import { makeClient } from './helpers/make-client.js';
import { probeDocker, itIfDocker } from './helpers/docker-skip.js';
import { useTempStorageRoot } from './helpers/temp-storage.js';
import { WORKER_IMAGE } from './helpers/worker-image.js';
// `signCallback` is the SAME function the worker uses to compute the
// signature it puts on the wire. Importing it here (instead of duplicating
// the createHmac call) makes the "symmetry" assertion structural: if
// `signCallback`'s behavior ever drifts, both sides drift together and the
// test still passes; if the WORKER drifts away from `signCallback`, this
// test catches it. We also pull it through the package barrel (`../../`
// dist path, matching make-client.ts) to exercise the public export shape.
import { signCallback } from '../../packages/pangolin-client/dist/index.js';

probeDocker();
const storageRoot = useTempStorageRoot('e2e-callback');

interface CapturedPost {
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
let received: CapturedPost[] = [];

beforeEach(() => {
  received = [];
  server = http.createServer((req, res) => {
    // We accept POSTs to any path; the test asserts on the captured body
    // and headers regardless of path. The pangolin-worker only ever POSTs, so
    // GET / HEAD probes (some health checks) would be a wiring bug.
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = 200;
      res.end('ok');
    });
  });
  // Bind to all interfaces on an OS-assigned port (`0`). Binding to
  // `127.0.0.1` would be unreachable from inside the worker container.
  return new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
});

afterEach(() => {
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('E2E: callback signing roundtrip (§7.3)', () => {
  itIfDocker(
    'dispatch posts HMAC-signed lifecycle events that verify against the per-dispatch key',
    async () => {
      const port = (server.address() as AddressInfo).port;
      // host.docker.internal: Docker Desktop on Windows/Mac auto-resolves
      // this to the host. On Linux without an `extra_hosts: host-gateway`
      // mapping the worker won't reach us — see the file header for why
      // that's an accepted skip on Linux for now.
      const callbackUrl = `http://host.docker.internal:${port}/cb`;

      const client = makeClient({
        namespace: 'callback-roundtrip',
        storageRoot: storageRoot(),
      });

      // Minimal capability + subagent + env to drive a dispatch through. The
      // exact behavior of the subagent body is uninteresting — we only need
      // a successful dispatch so the worker emits `dispatch.started` and
      // `dispatch.finished`, which are the two POSTs we'll verify.
      const cap = await client.capabilities.register({
        name: 'noop-cap',
        files: { 'pangolin-setup.sh': '#!/bin/sh\necho "setup ran"\n' },
      });
      await client.subagent.register({
        name: 'echo-agent',
        systemPrompt: 'Print "hello" and exit.',
        capabilities: [cap],
      });
      await client.env.register({
        name: 'minimal',
        values: { LOG_LEVEL: 'info' },
      });

      // CAPTURING THE HMAC KEY:
      //
      // `mintCallbackHmac` generates a random 32-byte hex key, stages it in
      // Secrets Manager under `pangolin/callback-hmac/<dispatchId>`, and
      // returns the ARN. The worker reads that same secret to sign each
      // POST. To verify signatures from the test side we need the key.
      //
      // Two ways to get it:
      //   (a) Patch `mintCallbackHmac` to surface the generated key — would
      //       require modifying pangolin-client just for tests.
      //   (b) Read the secret back from Secrets Manager via the SAME ARN
      //       the worker uses, using the AWS SDK from the test process.
      //
      // We pick (b): we provide a fixed `dispatchId` so we can predict the
      // secret name, then after dispatch we resolve the secret out of band.
      // Using a deterministic dispatchId also lets us re-verify the header
      // value `X-Pangolin-Dispatch-Id` matches.
      const dispatchId = `e2e-callback-${Date.now()}`;

      const result = await client.dispatch({
        subagent: 'echo-agent',
        env: 'minimal',
        target: 'local',
        dispatchId,
        callback: { url: callbackUrl, signatureAlgorithm: 'sha256' },
        timeoutSeconds: 60,
        workerImage: WORKER_IMAGE,
      } as never);

      expect(result.exitCode).toBe(0);
      expect(result.dispatchId).toBe(dispatchId);

      // The worker emits TWO lifecycle events on the happy path:
      // `dispatch.started` (entrypoint step 5) and `dispatch.finished`
      // (entrypoint step 14). Both go through `LifecycleEmitter.emit`,
      // which POSTs to PANGOLIN_CALLBACK_URL. We expect at least both.
      expect(received.length).toBeGreaterThanOrEqual(2);

      // Resolve the HMAC key the worker used by fetching the same Secrets
      // Manager entry. The ARN pattern is fixed by `mintCallbackHmac`:
      // `pangolin/callback-hmac/<dispatchId>`.
      //
      // RACE WARNING: `dispatchWork` fires its best-effort secret cleanup in
      // a `finally` block. That cleanup tag-filters on `pangolin:dispatchId`
      // and `mintCallbackHmac` also tags with that key, so cleanup CAN
      // delete the callback HMAC secret out from under us. We mitigate by
      // (a) fetching immediately upon dispatch return (the dispatch's
      // finally schedules cleanup, doesn't await it; our `await` here is
      // the very next thing to resolve) and (b) the cleanup ListSecrets
      // result is eventually consistent — the freshly-created HMAC secret
      // often hasn't propagated to the list index yet when cleanup runs,
      // so cleanup misses it and the TTL tag handles eventual removal.
      // If this race ever flakes in CI, the right fix is to surface the
      // minted key from `dispatchWork` (e.g. via a debug return field) so
      // the test doesn't have to fish it back out of Secrets Manager.
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

      // Verify every captured POST:
      //   - X-Pangolin-Signature == sha256=<hex HMAC over `${id}.${ts}.${body}`>
      //   - X-Pangolin-Dispatch-Id == the dispatch's id
      //   - X-Pangolin-Timestamp parseable + within 5 minutes (§7.3 replay)
      // Verifying ALL captured POSTs (rather than just the first two)
      // catches a regression where one event kind is signed correctly but
      // another is mis-signed.
      const verifierClockMs = Date.now();
      const skewBudgetMs = 5 * 60 * 1000;

      for (const post of received) {
        const sigHeader = post.headers['x-pangolin-signature'];
        const timestamp = post.headers['x-pangolin-timestamp'];
        const seenDispatchId = post.headers['x-pangolin-dispatch-id'];
        expect(typeof sigHeader).toBe('string');
        expect(typeof timestamp).toBe('string');
        expect(typeof seenDispatchId).toBe('string');
        expect(seenDispatchId).toBe(dispatchId);

        // The `signCallback` helper from pangolin-client is the SAME code the
        // worker's LifecycleEmitter mirrors — using it here proves the
        // client-side and worker-side signing are byte-for-byte symmetric.
        const expectedHex = signCallback({
          hmacKey,
          dispatchId,
          timestampIso: timestamp as string,
          payload: post.body,
        });
        expect(sigHeader).toBe(`sha256=${expectedHex}`);

        // Cross-check directly with createHmac too. If `signCallback`
        // changes shape under us this still pins the wire format.
        const directHex = createHmac('sha256', hmacKey)
          .update(`${dispatchId}.${timestamp as string}.${post.body}`)
          .digest('hex');
        expect(sigHeader).toBe(`sha256=${directHex}`);

        // §7.3 replay-protection skew: timestamps must be within 5 minutes
        // of verifier wall clock. Parsing the ISO string returns NaN for
        // malformed values; we assert finite first so a malformed header
        // surfaces as a parse failure rather than a math NaN.
        const tsMs = new Date(timestamp as string).getTime();
        expect(Number.isFinite(tsMs)).toBe(true);
        expect(Math.abs(verifierClockMs - tsMs)).toBeLessThan(skewBudgetMs);

        // Body must be valid JSON (lifecycle events are objects).
        const parsed = JSON.parse(post.body) as { dispatchId?: string; kind?: string };
        expect(parsed.dispatchId).toBe(dispatchId);
        expect(typeof parsed.kind).toBe('string');
      }

      // Pin the lifecycle event kinds observed: §7.3 acceptance requires at
      // least `dispatch.started` and `dispatch.finished` per the entrypoint
      // §6.2 happy path (steps 5 + 14).
      const kinds = received.map((p) => {
        const parsed = JSON.parse(p.body) as { kind?: string };
        return parsed.kind;
      });
      expect(kinds).toContain('dispatch.started');
      expect(kinds).toContain('dispatch.finished');
    },
    120_000,
  );
});
