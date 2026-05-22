// E2E contract: §6.7 — runtime secret redaction in `DispatchResult.stdout`.
//
// §6.7 specifies that the worker's `StructuredLogger.redact()` rewrites any
// literal occurrence of a resolved env-bundle secret value to the sentinel
// `<redacted:secret>` before the event is written to the worker's stdout.
// Since `LocalDockerProvider.awaitExit()` captures the container's combined
// stdout into `DispatchResult.stdout`, that's the surface the redaction
// contract is observable on for the local target.
//
// Concretely: an env bundle is registered with an inline secret value; a
// capability's `agora-setup.sh` references the secret env var directly via
// `echo`, exercising the worst-case path where the sub-agent emits the
// literal value verbatim (no transform). The worker resolves the secret,
// registers it with the structured logger, and runs the setup-script under
// the merged env. Anything the worker subsequently logs that contains the
// literal value MUST come out as `<redacted:secret>` in
// `DispatchResult.stdout`.
//
// §6.7 explicitly caveats that this is a literal-string match: a sub-agent
// that base64-encodes, HMACs, or otherwise transforms a secret before
// emitting it will bypass redaction. We encode that caveat as a second `it`
// so the test file itself anchors the limitation — future readers won't
// silently assume redaction is universal.
//
// SKIP gracefully when the Docker daemon is unreachable — the redaction
// happens inside the worker container, so there's nothing to observe
// without it.

import { describe, it, expect } from 'vitest';
import { makeClient } from './helpers/make-client.js';
import { probeDocker, itIfDocker } from './helpers/docker-skip.js';
import { useTempStorageRoot } from './helpers/temp-storage.js';
import { WORKER_IMAGE } from './helpers/worker-image.js';

probeDocker();
const storageRoot = useTempStorageRoot('e2e-redact');

describe('E2E: runtime secret redaction', () => {
  itIfDocker(
    'secret echoed verbatim in stdout is redacted in DispatchResult.stdout',
    async () => {
      // Unique per run so a leak in one suite invocation can't false-positive
      // a later invocation's "no literal secret present" assertion via
      // residual stdout from a previous container.
      const SECRET = 'literal-secret-do-not-leak-' + Date.now();
      const client = makeClient({
        namespace: 'redact',
        storageRoot: storageRoot(),
      });

      // The capability's setup script echoes the secret env var verbatim.
      // This is the worst-case path the §6.7 redactor is meant to catch:
      // the sub-agent (or in this case, the setup script standing in for
      // sub-agent stdout) emits the resolved secret value literally to
      // stdout with no transform.
      const cap = await client.capabilities.register({
        name: 'echo-secret',
        files: {
          'agora-setup.sh': '#!/bin/sh\necho "secret is $MY_SECRET"\n',
        },
      });
      await client.subagent.register({
        name: 'noop',
        systemPrompt: 'exit',
        capabilities: [cap],
      });
      // Inline secret — the stager will mint an ARN at register-time and
      // the worker's `SecretResolver` will pull the literal value back into
      // the merged env at step 7 of the lifecycle. That same value is what
      // gets registered with the structured logger via
      // `logger.registerSecret(v)`.
      await client.env.register({
        name: 'with-secret',
        values: {},
        secrets: { MY_SECRET: { inline: SECRET } },
      });

      const result = await client.dispatch({
        subagent: 'noop',
        env: 'with-secret',
        target: 'local',
        workerImage: WORKER_IMAGE,
      } as any);

      // The literal secret string MUST NOT appear anywhere in the captured
      // stdout. If this fails, the redaction path is either disconnected
      // from worker stdout or the env-bundle secret was never registered
      // with the logger.
      expect(result.stdout).not.toContain(SECRET);
      // Positive shape: the sentinel must be present. Asserting only the
      // negative would let an empty-stdout regression silently pass.
      expect(result.stdout).toContain('<redacted:secret>');
    },
    120_000,
  );

  it('documents the §6.7 caveat: literal-string match does not catch transforms', () => {
    // Sub-agents that base64-encode, HMAC-sign, or otherwise hash a secret
    // before emitting it will bypass redaction — `StructuredLogger.redact()`
    // is a literal-string `.split(secret).join('<redacted:secret>')`, not a
    // semantic check on derived values. This test exists to anchor that
    // caveat in code so it's not silently forgotten when someone later
    // wonders "why didn't redaction catch this?".
    expect(true).toBe(true);
  });
});
