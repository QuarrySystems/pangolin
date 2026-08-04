import { it, expect } from 'vitest';
import { writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseEnvPayload,
  restoreCredentials,
  CredentialRestoreError,
} from '../src/credential-restore.js';

// --- parseEnvPayload -------------------------------------------------------

it('preserves a value containing = and newlines (JSON bundle refs)', () => {
  // NUL framing exists precisely for this: PANGOLIN_BUNDLE_REFS_JSON is
  // arbitrary JSON, so newline framing would corrupt it. This is the same
  // framing /proc/<pid>/environ itself uses.
  const json = '{"subagent":{"uri":"a=b"},"n":"line1\nline2"}';
  expect(parseEnvPayload(`PANGOLIN_BUNDLE_REFS_JSON=${json}\0PATH=/usr/bin\0`)).toEqual({
    PANGOLIN_BUNDLE_REFS_JSON: json,
    PATH: '/usr/bin',
  });
});

it('ignores a trailing NUL rather than producing an empty-key entry', () => {
  const parsed = parseEnvPayload('A=1\0B=2\0');
  expect(parsed).toEqual({ A: '1', B: '2' });
  expect(Object.keys(parsed)).toHaveLength(2);
  expect('' in parsed).toBe(false);
});

it('throws on an entry with no = and on an entry starting with =', () => {
  expect(() => parseEnvPayload('NOEQUALS\0')).toThrow(CredentialRestoreError);
  // A leading '=' means an empty key, which would silently create a junk entry.
  expect(() => parseEnvPayload('=novalue\0')).toThrow(CredentialRestoreError);
});

it('keeps an empty value, which is distinct from a malformed entry', () => {
  expect(parseEnvPayload('EMPTY=\0')).toEqual({ EMPTY: '' });
});

// --- restoreCredentials ----------------------------------------------------

it('with no PANGOLIN_CRED_FD returns [] and adds nothing', () => {
  const env: NodeJS.ProcessEnv = { EXISTING: 'x' };
  expect(restoreCredentials(env)).toEqual([]);
  expect(env).toEqual({ EXISTING: 'x' });
});

it('throws rather than silently continuing when the fd is unreadable', () => {
  // A quiet degrade here walks the credential chain into an IMDS timeout on the
  // POST-agent upload path — where the work is already done and about to be
  // lost. Failing loudly at boot is strictly better.
  expect(() => restoreCredentials({ PANGOLIN_CRED_FD: '9999' })).toThrow(CredentialRestoreError);
});

it('throws for a non-integer fd rather than coercing it', () => {
  expect(() => restoreCredentials({ PANGOLIN_CRED_FD: 'abc' })).toThrow(CredentialRestoreError);
  expect(() => restoreCredentials({ PANGOLIN_CRED_FD: '-1' })).toThrow(CredentialRestoreError);
});

it('restores keys onto the passed object, deletes the fd var, and returns the key names', () => {
  const path = join(tmpdir(), `cred-restore-${process.pid}-${Date.now()}`);
  writeFileSync(path, 'AWS_ACCESS_KEY_ID=AKIA_TEST\0PANGOLIN_CALLBACK_TOKEN_REF=arn:x\0');
  const fd = openSync(path, 'r');
  try {
    const env: NodeJS.ProcessEnv = { PANGOLIN_CRED_FD: String(fd), KEEP: 'me' };
    const restored = restoreCredentials(env);

    expect(restored.sort()).toEqual(['AWS_ACCESS_KEY_ID', 'PANGOLIN_CALLBACK_TOKEN_REF']);
    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIA_TEST');
    expect(env.PANGOLIN_CALLBACK_TOKEN_REF).toBe('arn:x');
    expect(env.KEEP).toBe('me');
    // The fd var must not survive: it would otherwise be inherited by the agent
    // and point at a readable credential payload.
    expect('PANGOLIN_CRED_FD' in env).toBe(false);
  } finally {
    closeSync(fd);
    unlinkSync(path);
  }
});
