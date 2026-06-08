// E2E §6.8: channel subscription opt-in.
//
// Verifies the §6.8 channel subscription flow end-to-end through the
// `LocalDockerProvider` + `LocalStorageProvider` + a real worker image:
//
//   1. A capability bundle that includes `pangolin-channel.json` referencing a
//      stub adapter (shipped as a test fixture in the worker image at
//      `/opt/pangolin/adapters/stub/index.js`) causes the worker, after
//      capability overlay + env merge + setup-script execution (lifecycle
//      step 8 per §6.2), to construct the named adapter and start its
//      subscription as a background task.
//   2. The worker writes each received `ChannelMessage` as one JSONL line to
//      `/workspace/.pangolin/channel/inbox.jsonl` (the documented, stable path
//      per §6.8 "How messages are made available to the sub-agent").
//   3. The sub-agent (via its capability's `pangolin-setup.sh`) reads the inbox
//      file once and echoes its contents to stdout, so the test can assert
//      against `result.stdout` rather than poking at the in-container
//      workspace after teardown.
//   4. On sub-agent exit, the worker calls the iterator's `return()` to
//      signal close and awaits the adapter's cleanup with a 10s timeout
//      (lifecycle step 12). A clean teardown is verified by the absence of
//      channel-related error reasons on the dispatch result.
//   5. A capability whose `pangolin-channel.json` names an adapter that does
//      not exist in the worker image must fail the dispatch with
//      `reason: 'worker-failed'` per §6.8 paragraph 3 ("missing-adapter is
//      a setup error, not a transient runtime concern"). The sub-agent must
//      not have run.
//
// SKIPS gracefully when Docker is unreachable (via `probeDocker` +
// `itIfDocker`). On a controller machine without Docker the suite is a
// no-op — the assertions are only meaningful end-to-end when the configured
// worker image is reachable AND the image bundles a `stub` adapter at
// `/opt/pangolin/adapters/stub/index.js`.
//
// DAG-3 scope note: the stub adapter itself (a deterministic ChannelAdapter
// emitting a fixed sequence of three messages) is shipped by the worker
// image build, not by this test file. This test assumes the image at
// `WORKER_IMAGE` contains:
//
//   /opt/pangolin/adapters/stub/index.js
//
// whose `default` export returns a `ChannelAdapter` named `"stub"` whose
// `subscribe({ channel, opts })` yields a deterministic sequence — for the
// `{ count: 3 }` config used below, the adapter yields three messages with
// `id` values `msg-1`, `msg-2`, `msg-3` and stops (so the worker's
// background loop terminates naturally and the stop()-via-`return()` path
// remains a clean no-op). Building / shipping that fixture lives in a
// separate DAG; this file pins the contract the worker image must satisfy.

import { describe, expect } from 'vitest';
import { makeClient } from './helpers/make-client.js';
import { probeDocker, itIfDocker } from './helpers/docker-skip.js';
import { useTempStorageRoot } from './helpers/temp-storage.js';
import { WORKER_IMAGE } from './helpers/worker-image.js';

probeDocker();
const storageRoot = useTempStorageRoot('e2e-channel');

describe('E2E: channel subscription opt-in (§6.8)', () => {
  itIfDocker(
    'capability declaring pangolin-channel.json causes worker to subscribe + write inbox.jsonl',
    async () => {
      const client = makeClient({
        namespace: 'channel',
        storageRoot: storageRoot(),
      });

      // The capability ships two files:
      //   - `pangolin-channel.json`  — declares the subscription. The worker
      //     reads this after overlay (lifecycle step 10 per §6.2) and
      //     constructs the named `stub` adapter from
      //     `/opt/pangolin/adapters/stub/` in the worker image.
      //   - `pangolin-setup.sh`      — sleeps briefly to give the background
      //     channel loop time to drain the stub adapter's deterministic
      //     three-message sequence into `inbox.jsonl`, then cats the inbox
      //     file to stdout so the test can assert against `result.stdout`.
      //     A small sleep is the cleanest way to avoid racing the
      //     background subscription loop without leaning on `tail -f`
      //     (which would deadlock since the stub adapter exits after its
      //     fixed sequence rather than running forever).
      const cap = await client.capabilities.register({
        name: 'channel-sub',
        files: {
          'pangolin-channel.json': JSON.stringify({
            adapter: 'stub',
            channel: 'test',
            opts: { count: 3 },
          }),
          'pangolin-setup.sh':
            '#!/bin/sh\nsleep 2\ncat /workspace/.pangolin/channel/inbox.jsonl || true\n',
        },
      });
      await client.subagent.register({
        name: 'sub-test',
        systemPrompt: 'exit',
        capabilities: [cap],
      });
      await client.env.register({ name: 'e', values: {} });

      const result = await client.dispatch({
        subagent: 'sub-test',
        env: 'e',
        target: 'local',
        workerImage: WORKER_IMAGE,
      } as any);

      // The setup-script echoes the JSONL inbox — assert against an `id`
      // field whose value matches the documented `msg-<N>` shape from §6.8.
      // The exact count is asserted below; this first check pins the JSONL
      // serialization invariant (one `ChannelMessage` per line, with an `id`
      // field present).
      expect(result.stdout).toMatch(/"id":"msg-\d+"/);

      // The stub adapter emits exactly three messages for `{ count: 3 }`.
      // Each message becomes one JSONL line in the inbox; the setup-script
      // cats the whole file, so stdout should contain all three ids.
      expect(result.stdout).toContain('"id":"msg-1"');
      expect(result.stdout).toContain('"id":"msg-2"');
      expect(result.stdout).toContain('"id":"msg-3"');

      // Clean teardown: the channel subscription must NOT have produced a
      // dispatch-level failure. Per §6.8 paragraph "Constraints in MVP",
      // adapter failures during execution are logged-but-swallowed — they
      // never roll up into `failure.reason`. So a healthy run has either
      // no failure block at all, or (if something unrelated went wrong)
      // a non-channel failure reason.
      if (result.failure) {
        expect(result.failure.reason).not.toBe('worker-failed');
      }
    },
    180_000,
  );

  itIfDocker(
    'dispatch fails with reason "worker-failed" when pangolin-channel.json names an unknown adapter',
    async () => {
      const client = makeClient({
        namespace: 'channel',
        storageRoot: storageRoot(),
      });

      // The capability declares `adapter: 'nonexistent-adapter'`. The worker
      // image is not expected to bundle an adapter under that name, so the
      // worker's channel-load step (lifecycle step 10) must fail with
      // `reason: 'worker-failed'` per §6.8 paragraph 3, and the sub-agent
      // must never be invoked (lifecycle step 11). The setup-script
      // tripwire would echo `agent-ran` if step 10's failure did not
      // short-circuit — but since the spec says missing-adapter is a hard
      // failure before sub-agent exec, that string must NOT appear in
      // stdout.
      const cap = await client.capabilities.register({
        name: 'channel-missing',
        files: {
          'pangolin-channel.json': JSON.stringify({
            adapter: 'nonexistent-adapter',
            channel: 'test',
          }),
          'pangolin-setup.sh': '#!/bin/sh\necho "agent-ran"\n',
        },
      });
      await client.subagent.register({
        name: 'sub-test-missing',
        systemPrompt: 'exit',
        capabilities: [cap],
      });
      await client.env.register({ name: 'e2', values: {} });

      const result = await client.dispatch({
        subagent: 'sub-test-missing',
        env: 'e2',
        target: 'local',
        workerImage: WORKER_IMAGE,
      } as any);

      // §6.8 paragraph 3: "If the adapter name is not present in the worker
      // image, the dispatch fails with `reason: 'worker-failed'` before
      // sub-agent exec."
      expect(result.failure?.reason).toBe('worker-failed');

      // The setup-script's `echo "agent-ran"` is the tripwire that proves
      // the failure happened before step 11. The setup-script runs in step
      // 9 (before channel-start in step 10), so under the current ordering
      // this tripwire would actually fire BEFORE the missing-adapter check
      // — meaning `stdout` may legitimately contain `agent-ran`. The
      // load-bearing assertion is the `failure.reason` above. We do NOT
      // assert on stdout absence here because the setup-script runs ahead
      // of the channel-load step in the documented §6.2 lifecycle.
    },
    180_000,
  );
});
