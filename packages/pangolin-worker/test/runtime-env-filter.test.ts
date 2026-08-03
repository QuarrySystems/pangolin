import { describe, it, expect } from 'vitest';
import { filterRuntimeEnv } from '../src/runtime-env-filter.js';

describe('filterRuntimeEnv (default-deny allow-list)', () => {
  it('passes built-in non-credential vars', () => {
    const out = filterRuntimeEnv({
      PATH: '/usr/bin',
      HOME: '/home/pangolin',
      LANG: 'C.UTF-8',
      TZ: 'UTC',
      TERM: 'xterm',
      NODE_ENV: 'production',
      AWS_REGION: 'us-east-1',
      AWS_DEFAULT_REGION: 'us-east-1',
    });
    expect(out).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/pangolin',
      LANG: 'C.UTF-8',
      TZ: 'UTC',
      TERM: 'xterm',
      NODE_ENV: 'production',
      AWS_REGION: 'us-east-1',
      AWS_DEFAULT_REGION: 'us-east-1',
    });
  });
  it('passes LC_* by built-in prefix', () => {
    const out = filterRuntimeEnv({ LC_ALL: 'C', LC_CTYPE: 'UTF-8' });
    expect(out).toEqual({ LC_ALL: 'C', LC_CTYPE: 'UTF-8' });
  });
  it('DROPS arbitrary user vars and credentials by default', () => {
    const out = filterRuntimeEnv({
      GITHUB_TOKEN: 'ghp_x',
      MY_APP_FLAG: 'true',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_ACCESS_KEY_ID: 'AKIA...',
      LOG_LEVEL: 'debug',
    });
    expect(out).toEqual({});
  });
  it('DROPS PANGOLIN_* control-plane vars', () => {
    const out = filterRuntimeEnv({
      PANGOLIN_DISPATCH_ID: 'd-1',
      PANGOLIN_CALLBACK_TOKEN_REF: 'arn:...:hmac',
      PANGOLIN_NAMESPACE: 'ns',
      PANGOLIN_STORAGE_URI: 's3://bucket',
      PANGOLIN_BUNDLE_REFS_JSON: '{}',
      PANGOLIN_CALLBACK_URL: 'https://example.com/cb',
      PANGOLIN_CALLBACK_BEARER_REF: 'secretref://b',
      PANGOLIN_PER_DISPATCH_SECRET_REFS_JSON: '{}',
      PATH: '/usr/bin',
    });
    expect(Object.keys(out).filter((k) => k.startsWith('PANGOLIN_'))).toEqual([]);
    expect(out.PATH).toBe('/usr/bin');
  });

  /**
   * The firewall's purpose is to withhold CREDENTIALS and the worker's
   * identity — not to withhold the adapter's own configuration. Permission
   * mode is a mode string with no credential value, and `ctx.env` is the only
   * channel an adapter has for adapter-specific config.
   *
   * Before this, an operator who set PANGOLIN_CLAUDE_PERMISSION_MODE=strict on
   * the worker had it silently stripped here, so `resolveBypassFlag` saw
   * nothing and passed `--dangerously-skip-permissions` anyway. Measured, not
   * inferred: the var never reached ctx.env through the real worker lifecycle.
   * A safety control that fails OPEN, with no error and no warning.
   */
  it('PASSES the named non-credential adapter-config vars', () => {
    const out = filterRuntimeEnv({
      PANGOLIN_CLAUDE_PERMISSION_MODE: 'strict',
      PANGOLIN_DISABLE_NEEDS_INPUT_HELPER: 'true',
      PATH: '/usr/bin',
    });
    expect(out.PANGOLIN_CLAUDE_PERMISSION_MODE).toBe('strict');
    expect(out.PANGOLIN_DISABLE_NEEDS_INPUT_HELPER).toBe('true');
  });

  it('allows adapter config by EXACT NAME, never by PANGOLIN_ prefix', () => {
    // A prefix rule would be the lazy way to fix the above and would re-open
    // the whole firewall — the callback HMAC key reference is a PANGOLIN_ var.
    // This is the test that stops that shortcut being taken later.
    const out = filterRuntimeEnv({
      PANGOLIN_CLAUDE_PERMISSION_MODE: 'strict',
      PANGOLIN_CALLBACK_TOKEN_REF: 'arn:...:hmac',
      PANGOLIN_CLAUDE_SOMETHING_ELSE: 'nope',
    });
    expect(out).toEqual({ PANGOLIN_CLAUDE_PERMISSION_MODE: 'strict' });
  });
  it('passes operator allow-list exact names', () => {
    const out = filterRuntimeEnv({ MY_APP_FLAG: 'true', OTHER: 'x' }, { allow: ['MY_APP_FLAG'] });
    expect(out).toEqual({ MY_APP_FLAG: 'true' });
  });
  it('passes operator allow-list PREFIX_* trailing-glob', () => {
    const out = filterRuntimeEnv(
      { MYAPP_FOO: '1', MYAPP_BAR: '2', OTHER: 'x' },
      { allow: ['MYAPP_*'] },
    );
    expect(out).toEqual({ MYAPP_FOO: '1', MYAPP_BAR: '2' });
  });
  it('ignores empty/whitespace allow entries', () => {
    const out = filterRuntimeEnv({ FOO: '1' }, { allow: ['', '  '] });
    expect(out).toEqual({});
  });
  it('does not mutate the input object', () => {
    const input = { PANGOLIN_DISPATCH_ID: 'd-1', PATH: '/usr/bin' };
    filterRuntimeEnv(input);
    expect(input).toEqual({ PANGOLIN_DISPATCH_ID: 'd-1', PATH: '/usr/bin' });
  });
});

/**
 * The allow-list above is default-deny, but the operator can widen it, and a bare
 * `*` widens it all the way back to default-allow. These pin a set of names that
 * NO allow-list entry may pass, checked before the allow-list rather than after.
 *
 * The module docstring already forbids extending adapter-config by a `PANGOLIN_`
 * prefix precisely so the callback HMAC key reference cannot be re-exposed. That
 * reasoning was advisory; this makes it enforceable.
 *
 * Every test here carries a var that DOES pass, as a positive control. Without
 * one, each would pass identically if the allow-list had silently stopped running
 * altogether — an absence assertion on a dead instrument proves nothing.
 */
describe('filterRuntimeEnv hard-deny (not overridable by any allow-list)', () => {
  it('a bare * allow-list cannot pass a credential', () => {
    const out = filterRuntimeEnv(
      {
        AWS_ACCESS_KEY_ID: 'AKIA...',
        AWS_SECRET_ACCESS_KEY: 'secret',
        AWS_SESSION_TOKEN: 'token',
        PANGOLIN_CALLBACK_TOKEN_REF: 'arn:...:hmac',
        PANGOLIN_CALLBACK_BEARER_REF: 'secretref://b',
        PANGOLIN_PER_DISPATCH_SECRET_REFS_JSON: '{}',
        MY_APP_FLAG: 'true',
      },
      { allow: ['*'] },
    );
    // Control: `*` genuinely is in force, so the absences below mean something.
    expect(out.MY_APP_FLAG).toBe('true');
    expect(Object.keys(out)).toEqual(['MY_APP_FLAG']);
  });

  it('prefix globs cannot pass a credential either', () => {
    const env = {
      AWS_SECRET_ACCESS_KEY: 'secret',
      PANGOLIN_CALLBACK_TOKEN_REF: 'arn:...:hmac',
      AWS_REGION: 'us-east-1',
    };
    // AWS_REGION is the control in both: non-credential, and a built-in, so it
    // must survive a hard-deny that is scoped correctly.
    expect(filterRuntimeEnv(env, { allow: ['AWS_*'] })).toEqual({ AWS_REGION: 'us-east-1' });
    expect(filterRuntimeEnv(env, { allow: ['PANGOLIN_*'] })).toEqual({ AWS_REGION: 'us-east-1' });
  });

  /**
   * `AWS_CONTAINER_AUTHORIZATION_TOKEN` does NOT start with
   * `AWS_CONTAINER_CREDENTIALS_`, so a prefix rule written to that narrower
   * string misses it. Spec §3a enumerates it as one of the names the SDK's own
   * chain reads, alongside the two `AWS_CONTAINER_CREDENTIALS_*` URIs — and
   * warns in the same breath that the non-`AWS_ACCESS_*`-shaped ones are exactly
   * what gets missed when the list is written from memory.
   */
  it('covers the whole AWS_CONTAINER_ family, not just the CREDENTIALS_ ones', () => {
    const out = filterRuntimeEnv(
      {
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/x',
        AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/x',
        AWS_CONTAINER_AUTHORIZATION_TOKEN: 'bearer-x',
        MY_APP_FLAG: 'true',
      },
      { allow: ['*'] },
    );
    expect(out.MY_APP_FLAG).toBe('true');
    expect(Object.keys(out)).toEqual(['MY_APP_FLAG']);
  });

  it('denies the credential-provider-env names that are not AWS_ACCESS_*-shaped', () => {
    const out = filterRuntimeEnv(
      {
        AWS_CREDENTIAL_EXPIRATION: '2026-08-03T00:00:00Z',
        AWS_CREDENTIAL_SCOPE: 'scope',
        MY_APP_FLAG: 'true',
      },
      { allow: ['*'] },
    );
    expect(out.MY_APP_FLAG).toBe('true');
    expect(Object.keys(out)).toEqual(['MY_APP_FLAG']);
  });
});
