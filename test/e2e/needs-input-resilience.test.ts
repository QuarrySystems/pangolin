// E2E §6.9: needs_input convention error paths and helper-overlay wiring.
//
// The §6.9 contract has four failure / wiring properties this suite pins
// down end-to-end against the real worker (no mocks, no in-process stubs —
// every assertion fires AFTER the worker has read the sentinel from a
// containerized workspace):
//
//   1. The sentinel file at `/workspace/.pangolin/needs_input.json` is parsed
//      as JSON. Unparseable contents (truncated braces, raw text, …) MUST
//      surface as `result.failure.reason === 'worker-failed'` and the
//      `detail` must mention either a parse error or the missing required
//      `question` field. See `packages/pangolin-worker/src/needs-input.ts` —
//      both unparseable JSON and missing-question route to the same
//      `kind: 'malformed'` outcome with a structured `detail` string that
//      is propagated verbatim into the lifecycle `dispatch.failed` event's
//      reason context.
//
//   2. The `partial_state` field has a 1 MiB cap on its canonical-JSON
//      serialization. Anything larger MUST surface as
//      `result.failure.reason === 'worker-failed'` with a `detail` that
//      explicitly mentions the 1 MiB cap. The cap is enforced by the
//      worker (`needs-input.ts#resolveNeedsInputSentinel` — `ONE_MIB`
//      constant); the SKILL.md the sub-agent reads names the same limit so
//      this assertion is a paired contract test between the worker's
//      enforcement and the SKILL's documentation.
//
//   3. The `pangolin-needs-input-helper` overlay (a SKILL.md authored under
//      `.claude/skills/pangolin-needs-input/SKILL.md`) MUST be merged into
//      every workspace by default. The SKILL teaches the sub-agent how to
//      shape a valid sentinel — without it, every "I need input" path
//      degenerates into one of the failure modes above. The helper module
//      lives at `packages/pangolin-runtime-claude-code/src/needs-input-helper.ts`
//      (`getNeedsInputHelperOverlay()`); the adapter is responsible for
//      prepending its returned overlay to integrator capabilities before
//      the runtime spawn. We probe this by having the capability's
//      `pangolin-setup.sh` `cat` the on-disk SKILL.md path: a successful read
//      proves the overlay landed.
//
//   4. `PANGOLIN_DISABLE_NEEDS_INPUT_HELPER=true` (also defined in the same
//      helper module, exposed via `isHelperDisabled`) MUST suppress the
//      default overlay. We exercise this by registering an env bundle with
//      `values: { PANGOLIN_DISABLE_NEEDS_INPUT_HELPER: 'true' }` and asserting
//      the same on-disk probe reports the SKILL is absent.
//
// All four assertions run inside a real worker container reached via
// `LocalDockerProvider` + `LocalStorageProvider`. On a host without a
// reachable Docker daemon, every case PASSES-as-skipped (via the
// `itIfDocker` gate from `./helpers/docker-skip.ts`) — Gastly intentionally
// authors these against the spec ahead of full worker-image publication so
// the contract drift, if any, surfaces the moment the image lands.

import { describe, expect } from 'vitest';
import { makeClient } from './helpers/make-client.js';
import { probeDocker, itIfDocker } from './helpers/docker-skip.js';
import { useTempStorageRoot } from './helpers/temp-storage.js';
import { WORKER_IMAGE } from './helpers/worker-image.js';

probeDocker();
const storageRoot = useTempStorageRoot('e2e-needs-resilience');

// Conventional on-disk path of the helper overlay (matches
// `packages/pangolin-runtime-claude-code/src/needs-input-helper.ts`).
const HELPER_SKILL_PATH = '.claude/skills/pangolin-needs-input/SKILL.md';

describe('E2E: needs-input resilience (§6.9)', () => {
  itIfDocker(
    'malformed sentinel fails dispatch with reason "worker-failed"',
    async () => {
      // The capability writes a sentinel whose contents cannot be parsed
      // as JSON (raw text, no braces at all). The worker's
      // `resolveNeedsInputSentinel` MUST surface this as a `malformed`
      // outcome and the entrypoint MUST map that to `worker-failed`.
      //
      // The setup script writes the sentinel BEFORE the runtime adapter
      // is invoked. The adapter's `detectNeedsInputSentinel` then sees
      // the file and propagates its path to the worker, which validates.
      const client = makeClient({
        namespace: 'needs-malformed',
        storageRoot: storageRoot(),
      });

      const cap = await client.capabilities.register({
        name: 'malformed-sentinel-writer',
        files: {
          'pangolin-setup.sh':
            '#!/bin/sh\n' +
            'mkdir -p /workspace/.pangolin\n' +
            // Deliberately not JSON — bare text the parser will reject.
            'printf "this is not json at all" > /workspace/.pangolin/needs_input.json\n',
        },
      });
      await client.subagent.register({
        name: 'malformed-agent',
        systemPrompt: 'Just exit.',
        capabilities: [cap],
      });
      await client.env.register({ name: 'e', values: {} });

      const result = await client.dispatch({
        subagent: 'malformed-agent',
        env: 'e',
        target: 'local',
        timeoutSeconds: 60,
        workerImage: WORKER_IMAGE,
      } as any);

      expect(result.failure?.reason).toBe('worker-failed');
      // The detail must mention the parse failure or the missing-question
      // diagnostic — both routes are surfaced as `malformed` and the
      // worker's `detail` carries the underlying string verbatim.
      const detail = result.failure?.detail ?? '';
      expect(detail).toMatch(/parse|question|JSON|malformed/i);
    },
    120_000,
  );

  itIfDocker(
    'oversized partial_state (>1 MiB) fails dispatch with reason "worker-failed"',
    async () => {
      // The capability writes a sentinel whose `partial_state` field is
      // a string > 1 MiB. The worker computes the canonical-JSON size of
      // `partial_state` and the entrypoint maps `oversized` to
      // `worker-failed`. We use a 2 MiB filler — well over the 1 MiB cap
      // even after JSON-string escaping is taken into account.
      const client = makeClient({
        namespace: 'needs-oversized',
        storageRoot: storageRoot(),
      });

      const cap = await client.capabilities.register({
        name: 'oversized-sentinel-writer',
        files: {
          // Write a 2 MiB 'A' string into partial_state. The setup script
          // composes valid JSON envelope ({"question": "...", "partial_state": "..."}).
          // We use `printf` + `head -c` to generate the bulk to keep the
          // capability bundle itself small (the bulk is generated at run
          // time, not shipped in the bundle).
          'pangolin-setup.sh':
            '#!/bin/sh\n' +
            'set -e\n' +
            'mkdir -p /workspace/.pangolin\n' +
            'BIG=$(head -c 2097152 /dev/zero | tr "\\0" "A")\n' +
            'printf \'{"question":"q?","partial_state":"%s"}\' "$BIG" > /workspace/.pangolin/needs_input.json\n',
        },
      });
      await client.subagent.register({
        name: 'oversized-agent',
        systemPrompt: 'Just exit.',
        capabilities: [cap],
      });
      await client.env.register({ name: 'e', values: {} });

      const result = await client.dispatch({
        subagent: 'oversized-agent',
        env: 'e',
        target: 'local',
        timeoutSeconds: 60,
        workerImage: WORKER_IMAGE,
      } as any);

      expect(result.failure?.reason).toBe('worker-failed');
      // The 1 MiB cap MUST be named in the detail so an operator
      // reading the failure can immediately map it to §6.9 / the SKILL.
      const detail = result.failure?.detail ?? '';
      expect(detail).toMatch(/1 MiB|1MiB|oversized|1048576/i);
    },
    120_000,
  );

  itIfDocker(
    'pangolin-needs-input-helper overlay is applied by default',
    async () => {
      // The capability's setup script probes for the helper SKILL.md and
      // prints a deterministic marker if present. The overlay MUST land
      // by default — no opt-in required — so the marker MUST appear in
      // stdout.
      //
      // The setup script also `tee`s the SKILL contents into stdout as
      // a defense-in-depth check: if the overlay's path is correct but
      // the body is empty (a hypothetical regression in asset packaging),
      // stdout still reflects that an empty file was overlaid rather than
      // accidentally falling through to the "present" branch on size.
      const client = makeClient({
        namespace: 'needs-overlay-on',
        storageRoot: storageRoot(),
      });

      const cap = await client.capabilities.register({
        name: 'helper-probe',
        files: {
          'pangolin-setup.sh':
            '#!/bin/sh\n' +
            'if [ -s /workspace/' + HELPER_SKILL_PATH + ' ]; then\n' +
            '  echo "HELPER_PRESENT=yes"\n' +
            // Surface a known-from-the-SKILL.md token to catch a
            // hypothetical overlay-of-empty-file regression.
            '  grep -q "/workspace/.pangolin/needs_input.json" /workspace/' +
            HELPER_SKILL_PATH +
            ' && echo "HELPER_BODY=ok"\n' +
            'else\n' +
            '  echo "HELPER_PRESENT=no"\n' +
            'fi\n',
        },
      });
      await client.subagent.register({
        name: 'helper-probe-agent',
        systemPrompt: 'Just exit.',
        capabilities: [cap],
      });
      await client.env.register({ name: 'e', values: {} });

      const result = await client.dispatch({
        subagent: 'helper-probe-agent',
        env: 'e',
        target: 'local',
        timeoutSeconds: 60,
        workerImage: WORKER_IMAGE,
      } as any);

      expect(result.stdout).toContain('HELPER_PRESENT=yes');
      expect(result.stdout).toContain('HELPER_BODY=ok');
      expect(result.stdout).not.toContain('HELPER_PRESENT=no');
    },
    120_000,
  );

  itIfDocker(
    'PANGOLIN_DISABLE_NEEDS_INPUT_HELPER=true suppresses the overlay',
    async () => {
      // Same probe as above, but with the suppression env var set on the
      // env bundle. The worker's `parseWorkerEnv` flips
      // `disableNeedsInputHelper` to `true` and the adapter MUST NOT
      // prepend the helper overlay — so the SKILL.md path MUST be absent
      // from the post-overlay workspace.
      const client = makeClient({
        namespace: 'needs-overlay-off',
        storageRoot: storageRoot(),
      });

      const cap = await client.capabilities.register({
        name: 'helper-probe-disabled',
        files: {
          'pangolin-setup.sh':
            '#!/bin/sh\n' +
            'if [ -e /workspace/' + HELPER_SKILL_PATH + ' ]; then\n' +
            '  echo "HELPER_PRESENT=yes"\n' +
            'else\n' +
            '  echo "HELPER_PRESENT=no"\n' +
            'fi\n',
        },
      });
      await client.subagent.register({
        name: 'helper-disabled-agent',
        systemPrompt: 'Just exit.',
        capabilities: [cap],
      });
      await client.env.register({
        name: 'disable-helper',
        values: { PANGOLIN_DISABLE_NEEDS_INPUT_HELPER: 'true' },
      });

      const result = await client.dispatch({
        subagent: 'helper-disabled-agent',
        env: 'disable-helper',
        target: 'local',
        timeoutSeconds: 60,
        workerImage: WORKER_IMAGE,
      } as any);

      expect(result.stdout).toContain('HELPER_PRESENT=no');
      expect(result.stdout).not.toContain('HELPER_PRESENT=yes');
    },
    120_000,
  );
});
