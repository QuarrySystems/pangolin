// E2E: §7.1 credential-shaped values are rejected at register() time.
//
// The credential-shape scanner runs at the caller boundary so a credential
// that's accidentally pasted into an env bundle's `values:` or into a
// capability file's contents is rejected BEFORE it can be written to
// storage. The thrown `CredentialsInEnvError` identifies which field
// matched and which named pattern fired, but truncates the matched
// substring (first 16 chars + "...") so the full credential is never
// folded into logs.
//
// This file pins:
//   - All five canonical patterns (aws-access-key, aws-session-key, jwt,
//     bearer-prefix, github-token) reject when present in env `values:`.
//   - The same patterns reject when present in capability file CONTENTS
//     supplied as strings (binary files are not scanned by contract).
//   - `allowCredentialPatterns: ['<name>']` opts out a specific pattern by
//     its canonical name so a real false positive doesn't block work.
//   - The error carries the `field:` identifying the offending location
//     (`env-bundle:<name>:<key>` or `capability:<name>:<path>`).
//   - The error message contains ONLY the first 16 chars of the matched
//     substring — never the full credential.
//
// No Docker, no compute providers — just the client + LocalStorageProvider
// against a per-test scratch directory.

// Relative imports to package sources — the root vitest runner has no
// workspace-package symlinks at `<repo>/node_modules`, so we go directly to
// the source-tree barrels. Vitest transparently transpiles the `.ts` files
// resolved by the `.js`-suffixed NodeNext import specifiers used inside the
// source tree. (Same convention as test/e2e/runtime-adapter-seam.test.ts.)
import { PangolinClient } from '../../packages/pangolin-client/src/client.js';
// Bring the namespaced sub-API installer side-effect into scope so
// `client.env.register` and `client.capabilities.register` exist.
import '../../packages/pangolin-client/src/index.js';
import { NoopCredentialProvider } from '../../packages/pangolin-client/src/bundled-impls.js';
import { LocalStorageProvider } from '../../packages/pangolin-storage-local/src/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

let storageRoot: string;

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'e2e-creds-'));
});

afterEach(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

function makeClient(): PangolinClient {
  return new PangolinClient({
    namespace: 'creds-rejection',
    compute: {},
    credentials: { none: new NoopCredentialProvider() },
    storage: new LocalStorageProvider({ rootDir: storageRoot }),
    targets: {},
  });
}

/**
 * Shape-of an `Error` that carries the documented `CredentialsInEnvError`
 * fields. Used by the assertion helpers below to inspect the error's
 * payload.
 */
interface CredentialsInEnvErrorLike extends Error {
  field: string;
  detail: string;
}

/**
 * Assert the thrown value is a `CredentialsInEnvError`. Uses `name`-based
 * structural matching per the canonical errors.ts contract:
 *
 *   "Each error class sets `name` to its class name so callers can use
 *    `err.name === 'IntegrityMismatchError'` for structural matching, even
 *    across realms / serialized payloads."
 *
 * We rely on the name check (not `instanceof`) here because the e2e
 * harness reaches package internals through relative paths while the
 * thrower (`credential-pattern.ts`) imports the class via the
 * `@quarry-systems/pangolin-core` package specifier — two resolution paths
 * to the same source file yield two distinct class identities under
 * vitest, which would break a naive `instanceof` check.
 */
function expectCredentialsInEnvError(
  err: unknown,
): asserts err is CredentialsInEnvErrorLike {
  expect(err).toBeInstanceOf(Error);
  const e = err as Error & Partial<CredentialsInEnvErrorLike>;
  expect(e.name).toBe('CredentialsInEnvError');
  expect(typeof e.field).toBe('string');
  expect(typeof e.detail).toBe('string');
}

/** Drive a promise to completion and surface whatever it threw, or null. */
async function captureRejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (err) {
    return err;
  }
}

// Representative credential-shaped strings for each named pattern. Names
// here match the canonical pattern names in
// packages/pangolin-client/src/credential-pattern.ts so `allowCredentialPatterns`
// opt-outs line up exactly.
const AWS_ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const AWS_SESSION_KEY = 'ASIAIOSFODNN7EXAMPLE';
const JWT_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const BEARER_TOKEN = 'Bearer abcdef1234567890abcdef1234567890';
const GH_TOKEN_P = 'ghp_' + 'A'.repeat(36);
const GH_TOKEN_O = 'gho_' + 'B'.repeat(36);
const GH_TOKEN_S = 'ghs_' + 'C'.repeat(36);
const GH_TOKEN_U = 'ghu_' + 'D'.repeat(36);

describe('E2E: credentials-in-env rejection at register() time', () => {
  describe('env-bundle values', () => {
    it('rejects AWS access key (AKIA...) in env values', async () => {
      const err = await captureRejection(
        makeClient().env.register({
          name: 'leaky-aws-access',
          values: { AWS_KEY: AWS_ACCESS_KEY },
        }),
      );
      expectCredentialsInEnvError(err);
      expect(err.detail).toContain('aws-access-key');
    });

    it('rejects AWS session key (ASIA...) in env values', async () => {
      const err = await captureRejection(
        makeClient().env.register({
          name: 'leaky-aws-session',
          values: { AWS_SESSION: AWS_SESSION_KEY },
        }),
      );
      expectCredentialsInEnvError(err);
      expect(err.detail).toContain('aws-session-key');
    });

    it('rejects JWT-shaped string in env values', async () => {
      const err = await captureRejection(
        makeClient().env.register({
          name: 'leaky-jwt',
          values: { TOKEN: JWT_TOKEN },
        }),
      );
      expectCredentialsInEnvError(err);
      expect(err.detail).toContain('jwt');
    });

    it('rejects Bearer-prefix token in env values', async () => {
      const err = await captureRejection(
        makeClient().env.register({
          name: 'leaky-bearer',
          values: { AUTH: BEARER_TOKEN },
        }),
      );
      expectCredentialsInEnvError(err);
      expect(err.detail).toContain('bearer-prefix');
    });

    it('rejects GitHub personal-access token (ghp_) in env values', async () => {
      const err = await captureRejection(
        makeClient().env.register({
          name: 'leaky-ghp',
          values: { GH: GH_TOKEN_P },
        }),
      );
      expectCredentialsInEnvError(err);
      expect(err.detail).toContain('github-token');
    });

    it('rejects GitHub OAuth token (gho_) in env values', async () => {
      const err = await captureRejection(
        makeClient().env.register({
          name: 'leaky-gho',
          values: { GH: GH_TOKEN_O },
        }),
      );
      expectCredentialsInEnvError(err);
      expect(err.detail).toContain('github-token');
    });

    it('rejects GitHub server token (ghs_) in env values', async () => {
      const err = await captureRejection(
        makeClient().env.register({
          name: 'leaky-ghs',
          values: { GH: GH_TOKEN_S },
        }),
      );
      expectCredentialsInEnvError(err);
      expect(err.detail).toContain('github-token');
    });

    it('rejects GitHub user-to-server token (ghu_) in env values', async () => {
      const err = await captureRejection(
        makeClient().env.register({
          name: 'leaky-ghu',
          values: { GH: GH_TOKEN_U },
        }),
      );
      expectCredentialsInEnvError(err);
      expect(err.detail).toContain('github-token');
    });
  });

  describe('capability file contents (string inputs)', () => {
    it('rejects AWS access key in capability file contents', async () => {
      const err = await captureRejection(
        makeClient().capabilities.register({
          name: 'leaky-cap-aws',
          files: { 'settings.json': `{"key":"${AWS_ACCESS_KEY}"}` },
        }),
      );
      expectCredentialsInEnvError(err);
      expect(err.detail).toContain('aws-access-key');
    });

    it('rejects AWS session key in capability file contents', async () => {
      const err = await captureRejection(
        makeClient().capabilities.register({
          name: 'leaky-cap-aws-session',
          files: { 'settings.json': `{"key":"${AWS_SESSION_KEY}"}` },
        }),
      );
      expectCredentialsInEnvError(err);
      expect(err.detail).toContain('aws-session-key');
    });

    it('rejects JWT in capability file contents', async () => {
      const err = await captureRejection(
        makeClient().capabilities.register({
          name: 'leaky-cap-jwt',
          files: { 'config.yaml': `token: ${JWT_TOKEN}` },
        }),
      );
      expectCredentialsInEnvError(err);
      expect(err.detail).toContain('jwt');
    });

    it('rejects Bearer token in capability file contents', async () => {
      const err = await captureRejection(
        makeClient().capabilities.register({
          name: 'leaky-cap-bearer',
          files: { 'README.md': `Use header: "${BEARER_TOKEN}"` },
        }),
      );
      expectCredentialsInEnvError(err);
      expect(err.detail).toContain('bearer-prefix');
    });

    it('rejects GitHub ghp_ token in capability file contents', async () => {
      const err = await captureRejection(
        makeClient().capabilities.register({
          name: 'leaky-cap-ghp',
          files: { '.env': `GH_TOKEN=${GH_TOKEN_P}` },
        }),
      );
      expectCredentialsInEnvError(err);
      expect(err.detail).toContain('github-token');
    });

    it('rejects GitHub gho_ token in capability file contents', async () => {
      const err = await captureRejection(
        makeClient().capabilities.register({
          name: 'leaky-cap-gho',
          files: { '.env': `GH_TOKEN=${GH_TOKEN_O}` },
        }),
      );
      expectCredentialsInEnvError(err);
      expect(err.detail).toContain('github-token');
    });

    it('rejects GitHub ghs_ token in capability file contents', async () => {
      const err = await captureRejection(
        makeClient().capabilities.register({
          name: 'leaky-cap-ghs',
          files: { '.env': `GH_TOKEN=${GH_TOKEN_S}` },
        }),
      );
      expectCredentialsInEnvError(err);
      expect(err.detail).toContain('github-token');
    });

    it('rejects GitHub ghu_ token in capability file contents', async () => {
      const err = await captureRejection(
        makeClient().capabilities.register({
          name: 'leaky-cap-ghu',
          files: { '.env': `GH_TOKEN=${GH_TOKEN_U}` },
        }),
      );
      expectCredentialsInEnvError(err);
      expect(err.detail).toContain('github-token');
    });
  });

  describe('error contents', () => {
    it('env: error.field identifies env-bundle:<name>:<key>', async () => {
      const err = await captureRejection(
        makeClient().env.register({
          name: 'with-field',
          values: { OFFENDING_KEY: AWS_ACCESS_KEY },
        }),
      );
      expectCredentialsInEnvError(err);
      expect(err.field).toBe('env-bundle:with-field:OFFENDING_KEY');
      // The message folds the field in so it surfaces in plain logs too.
      expect(err.message).toContain('env-bundle:with-field:OFFENDING_KEY');
    });

    it('capability: error.field identifies capability:<name>:<path>', async () => {
      const err = await captureRejection(
        makeClient().capabilities.register({
          name: 'with-cap-field',
          files: { '.claude/settings.json': `{"k":"${AWS_ACCESS_KEY}"}` },
        }),
      );
      expectCredentialsInEnvError(err);
      expect(err.field).toBe(
        'capability:with-cap-field:.claude/settings.json',
      );
      expect(err.message).toContain(
        'capability:with-cap-field:.claude/settings.json',
      );
    });

    it('error message includes only first 8 chars of matched credential (no full leak)', async () => {
      const err = await captureRejection(
        makeClient().env.register({
          name: 'truncate-check',
          values: { K: AWS_ACCESS_KEY },
        }),
      );
      expectCredentialsInEnvError(err);
      // First 8 chars of the matched substring MAY be present (the cap, F12).
      expect(err.detail).toContain(AWS_ACCESS_KEY.slice(0, 8));
      // No more than 8 chars are disclosed.
      expect(err.detail).not.toContain(AWS_ACCESS_KEY.slice(0, 9));
      // The full credential MUST NOT be present anywhere in the surfaced
      // error — neither detail nor composed message.
      expect(err.detail).not.toContain(AWS_ACCESS_KEY);
      expect(err.message).not.toContain(AWS_ACCESS_KEY);
      // Truncation marker present.
      expect(err.detail).toContain('...');
    });
  });

  describe('allowCredentialPatterns opt-out', () => {
    it('opts out aws-access-key in env values', async () => {
      const ref = await makeClient().env.register({
        name: 'opt-out-aws',
        values: { AWS_KEY: AWS_ACCESS_KEY },
        allowCredentialPatterns: ['aws-access-key'],
      });
      expect(ref.name).toBe('opt-out-aws');
      expect(ref.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
    });

    it('opts out jwt in env values', async () => {
      const ref = await makeClient().env.register({
        name: 'opt-out-jwt',
        values: { TOKEN: JWT_TOKEN },
        allowCredentialPatterns: ['jwt'],
      });
      expect(ref.name).toBe('opt-out-jwt');
      expect(ref.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
    });

    it('opts out github-token in env values', async () => {
      const ref = await makeClient().env.register({
        name: 'opt-out-gh',
        values: { GH: GH_TOKEN_P },
        allowCredentialPatterns: ['github-token'],
      });
      expect(ref.name).toBe('opt-out-gh');
      expect(ref.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
    });

    it('opts out aws-access-key in capability file contents', async () => {
      const ref = await makeClient().capabilities.register({
        name: 'opt-out-cap-aws',
        files: { 'settings.json': `{"k":"${AWS_ACCESS_KEY}"}` },
        allowCredentialPatterns: ['aws-access-key'],
      });
      expect(ref.name).toBe('opt-out-cap-aws');
      expect(ref.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
    });

    it('opting out one pattern does NOT silence the others', async () => {
      // The bundle contains both an AWS key and a JWT. Allowing only the
      // AWS key should still trip the JWT detector.
      const err = await captureRejection(
        makeClient().env.register({
          name: 'partial-opt-out',
          values: { K: `${AWS_ACCESS_KEY} ${JWT_TOKEN}` },
          allowCredentialPatterns: ['aws-access-key'],
        }),
      );
      expectCredentialsInEnvError(err);
      expect(err.detail).toContain('jwt');
    });
  });
});
