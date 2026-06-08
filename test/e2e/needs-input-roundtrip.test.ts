// E2E §6.9: needs-input Shape A roundtrip.
//
// Verifies the full §6.9 Shape A contract end-to-end:
//
//   1. A sub-agent dispatch is started. During setup, the sub-agent (via
//      the capability's `pangolin-setup.sh`) writes the §6.9 sentinel file at
//      `.pangolin/needs_input.json` declaring a `question` and a
//      `partial_state` payload.
//   2. The `claude-code` runtime adapter's `detectNeedsInputSentinel` step
//      (`packages/pangolin-runtime-claude-code/src/sentinel-detector.ts`)
//      picks up the sentinel path after the model exits and surfaces it
//      to the worker via `RuntimeExit.needsInputSentinelPath`.
//   3. The worker resolves the sentinel
//      (`packages/pangolin-worker/src/needs-input.ts`), validates it, and emits
//      `dispatch.needs_input` instead of `dispatch.finished` (entrypoint
//      step 13). The container exits 0.
//   4. The orchestrator (this test) sees `DispatchResult.needsInput`
//      populated with the parsed `{ question, options?, context?,
//      partialState? }` payload and NO `failure` block (a paused dispatch
//      is not a failure).
//   5. The orchestrator re-dispatches the same sub-agent with the answer
//      and `partialState` carried back in as
//      `input: { answer, partial_state }`. The second dispatch's setup
//      script reads `PANGOLIN_INPUT_JSON`, detects that `partial_state` is
//      already provided, SKIPS writing the sentinel, and runs to
//      `dispatch.finished` with `exitCode === 0`.
//
// The roundtrip property the spec promises is:
//   first.dispatch.needs_input.payload ≡ second.dispatch.input.partial_state
// i.e. the partial_state the sub-agent emitted on the first dispatch is
// the partial_state the second dispatch reads back.
//
// The second `it` block configures a `callback` URL on the dispatch so the
// `LifecycleEmitter` POSTs every emitted event to a local HTTP listener.
// We assert that the first dispatch's emitted lifecycle event kinds include
// `dispatch.needs_input` and EXCLUDE `dispatch.finished` — the worker's
// entrypoint step 13 chooses one terminal kind or the other, never both.
//
// SKIPS gracefully on machines without a reachable Docker daemon
// (`docker.ping()` rejects), via the standard `probeDocker` + `itIfDocker`
// gate. The container-reach-to-host caveat from the callback-signing-
// roundtrip suite applies here too: on native Linux without a
// `host.docker.internal:host-gateway` entry, the callback POSTs never
// arrive — the suite still passes structurally because the first
// assertion block (no callback) carries the roundtrip property on its own.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, beforeEach, afterEach } from 'vitest';

import { makeClient } from './helpers/make-client.js';
import { probeDocker, itIfDocker } from './helpers/docker-skip.js';
import { useTempStorageRoot } from './helpers/temp-storage.js';
import { WORKER_IMAGE } from './helpers/worker-image.js';

probeDocker();
const storageRoot = useTempStorageRoot('e2e-needs');

interface CapturedPost {
  path: string | undefined;
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
      received.push({ path: req.url, body });
      res.statusCode = 200;
      res.end('ok');
    });
  });
  // Bind 0.0.0.0 so the worker container can reach us via
  // host.docker.internal — 127.0.0.1 inside the container would resolve to
  // the container itself, never the host process.
  return new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
});

afterEach(() => {
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

// The sentinel-writing setup-script is the heart of the roundtrip. It is
// deterministic — the convention any §6.9 sub-agent follows — and is
// conditional on `PANGOLIN_INPUT_JSON` so the SECOND dispatch (which carries
// `partial_state` back in via `input`) skips the write and runs to
// completion.
//
// The dispatch contract serializes `work.input` (default `{}`) into
// `PANGOLIN_INPUT_JSON` (see pangolin-client/src/dispatch.ts §5). The merged env
// the worker hands to `pangolin-setup.sh` therefore carries this var, which
// the script greps with a fixed substring — no JSON parser available in
// `/bin/sh`. Looking for the literal `"partial_state"` key in the JSON
// string is robust enough for the deterministic shape this test emits.
const SENTINEL_SETUP_SCRIPT = `#!/bin/sh
set -e
# Skip the sentinel write on the second dispatch, where the orchestrator
# has fed partial_state back in. Substring match on the literal JSON key
# is sufficient — PANGOLIN_INPUT_JSON is a JSON object, and on dispatch #1
# work.input is {} (no partial_state); on dispatch #2 it carries the key.
case "$PANGOLIN_INPUT_JSON" in
  *'"partial_state"'*)
    echo "second dispatch: skipping sentinel write"
    exit 0
    ;;
esac
mkdir -p /workspace/.pangolin
cat > /workspace/.pangolin/needs_input.json <<'EOF'
{"question": "What is the answer?", "partial_state": {"step": 1, "data": "intermediate"}}
EOF
echo "first dispatch: wrote sentinel"
`;

describe('E2E: needs-input Shape A roundtrip (§6.9)', () => {
  itIfDocker(
    'first dispatch emits needs_input; second dispatch with answer + partial_state completes',
    async () => {
      const client = makeClient({
        namespace: 'needs-input',
        storageRoot: storageRoot(),
      });

      // Capability owns the sentinel-writing setup script. The script is
      // identical across both dispatches; conditional behavior comes from
      // PANGOLIN_INPUT_JSON, not from a flag the integrator toggles.
      const cap = await client.capabilities.register({
        name: 'needs-helper',
        files: {
          'pangolin-setup.sh': SENTINEL_SETUP_SCRIPT,
        },
      });
      await client.subagent.register({
        name: 'asker',
        // System prompt is irrelevant: the sentinel is written by setup
        // BEFORE claude spawns, and `detectNeedsInputSentinel` (adapter
        // step 4) picks it up regardless of what the model said.
        systemPrompt: 'exit',
        capabilities: [cap],
      });
      await client.env.register({ name: 'e', values: {} });

      // ---- First dispatch ----
      // Per §6.9 Shape A, the first dispatch must NOT carry `partial_state`
      // in `input` — the sub-agent emits one, the orchestrator picks it up,
      // and the orchestrator carries it back on the next call.
      const result1 = await client.dispatch({
        subagent: 'asker',
        env: 'e',
        target: 'local',
        workerImage: WORKER_IMAGE,
      } as never);

      // First-dispatch contract:
      //   - `needsInput` is populated with `question`, optional `options`,
      //     optional `context`, and `partialState` carried verbatim from
      //     the sentinel's `partial_state` field (per ADR-0009 rename).
      //   - `failure` is undefined — a paused dispatch is not a failure.
      expect(result1.needsInput).toBeDefined();
      expect(result1.needsInput?.question).toBe('What is the answer?');
      expect(result1.needsInput?.partialState).toEqual({
        step: 1,
        data: 'intermediate',
      });
      expect(result1.failure).toBeUndefined();

      // ---- Second dispatch ----
      // The orchestrator re-dispatches the SAME sub-agent with the answer
      // and the partial_state from result1 carried back in. Per the
      // sentinel-writing setup script's conditional, the second dispatch
      // skips the sentinel write and runs to `dispatch.finished`.
      const result2 = await client.dispatch({
        subagent: 'asker',
        env: 'e',
        target: 'local',
        workerImage: WORKER_IMAGE,
        input: {
          answer: '42',
          partial_state: result1.needsInput?.partialState,
        },
      } as never);

      expect(result2.exitCode).toBe(0);
      expect(result2.needsInput).toBeUndefined();
      expect(result2.failure).toBeUndefined();
    },
    300_000,
  );

  itIfDocker(
    'first dispatch emits dispatch.needs_input lifecycle event (not dispatch.finished)',
    async () => {
      // This test exercises the callback-URL path, which is the only way
      // (today) to observe the worker's lifecycle event stream from the
      // outside. The capability's setup script is the SAME deterministic
      // sentinel-writer used by the roundtrip test above; we just don't
      // re-dispatch on the response side here — we observe the events.
      const port = (server.address() as AddressInfo).port;
      const callbackUrl = `http://host.docker.internal:${port}/cb`;

      const client = makeClient({
        namespace: 'needs-input-events',
        storageRoot: storageRoot(),
      });

      const cap = await client.capabilities.register({
        name: 'needs-helper-events',
        files: {
          'pangolin-setup.sh': SENTINEL_SETUP_SCRIPT,
        },
      });
      await client.subagent.register({
        name: 'asker-events',
        systemPrompt: 'exit',
        capabilities: [cap],
      });
      await client.env.register({ name: 'e', values: {} });

      const dispatchId = `e2e-needs-${Date.now()}`;

      await client.dispatch({
        subagent: 'asker-events',
        env: 'e',
        target: 'local',
        dispatchId,
        callback: { url: callbackUrl, signatureAlgorithm: 'sha256' },
        workerImage: WORKER_IMAGE,
      } as never);

      // Filter to POSTs on the callback path. Each body is the JSON-
      // serialized LifecycleEvent (see pangolin-worker/src/lifecycle.ts).
      const kinds = received
        .filter((p) => p.path === '/cb')
        .map((p) => {
          const parsed = JSON.parse(p.body) as { kind?: string };
          return parsed.kind;
        });

      // Per `packages/pangolin-worker/src/entrypoint.ts` step 13, a valid
      // needs_input sentinel produces a `dispatch.needs_input` terminal
      // event and EXCLUDES `dispatch.finished`. `dispatch.started` is
      // step 5 and fires regardless.
      expect(kinds).toContain('dispatch.started');
      expect(kinds).toContain('dispatch.needs_input');
      expect(kinds).not.toContain('dispatch.finished');
      expect(kinds).not.toContain('dispatch.failed');
    },
    300_000,
  );
});
