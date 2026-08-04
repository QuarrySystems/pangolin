import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDepsEvidence } from '../src/deps-evidence.js';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

/** Write `body` as `.pangolin/deps.json` in a fresh workspace and read it back. */
async function readInWorkspaceWith(body: string) {
  const dir = await mkdtemp(join(tmpdir(), 'deps-ev-'));
  await mkdir(join(dir, '.pangolin'), { recursive: true });
  await writeFile(join(dir, '.pangolin', 'deps.json'), body);
  return readDepsEvidence(dir);
}

it('is insensitive to key order — the same evidence hashes identically', async () => {
  const a = await readInWorkspaceWith('{"ecosystem":"pnpm","packageCount":2}');
  const b = await readInWorkspaceWith('{"packageCount":2,"ecosystem":"pnpm"}');
  // Positive control: both produced a real hash, so equality is not two failures
  // comparing equal. This is the case JSON.stringify(JSON.parse(...)) gets wrong,
  // and getting it wrong reports a spurious mid-run dependency change.
  expect(a).toEqual({ kind: 'ok', hash: expect.stringMatching(SHA256) });
  expect(b).toEqual({ kind: 'ok', hash: expect.stringMatching(SHA256) });
  expect(a).toEqual(b);
});

it('hashes differently when any value differs', async () => {
  const a = await readInWorkspaceWith('{"ecosystem":"pnpm","packageCount":2}');
  const b = await readInWorkspaceWith('{"ecosystem":"pnpm","packageCount":3}');
  expect(a).toEqual({ kind: 'ok', hash: expect.stringMatching(SHA256) });
  expect(b).toEqual({ kind: 'ok', hash: expect.stringMatching(SHA256) });
  expect(a).not.toEqual(b);
});

it('nested key order is also normalised, not just the top level', async () => {
  const a = await readInWorkspaceWith('{"a":{"x":1,"y":2},"b":3}');
  const b = await readInWorkspaceWith('{"b":3,"a":{"y":2,"x":1}}');
  expect(a).toEqual({ kind: 'ok', hash: expect.stringMatching(SHA256) });
  expect(a).toEqual(b);
});

it('returns exactly { kind: absent } when the file does not exist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deps-ev-none-'));
  await expect(readDepsEvidence(dir)).resolves.toEqual({ kind: 'absent' });
});

it('a missing workspace directory is absent, not a throw', async () => {
  await expect(readDepsEvidence(join(tmpdir(), 'deps-ev-does-not-exist-xyz'))).resolves.toEqual({
    kind: 'absent',
  });
});

it('a non-JSON body is unusable with a reason, and does not throw', async () => {
  // resolves.toMatchObject rather than a bare await: a rejection must FAIL here
  // rather than slipping through as a falsy value.
  await expect(readInWorkspaceWith('not json {')).resolves.toMatchObject({
    kind: 'unusable',
  });
  const res = await readInWorkspaceWith('not json {');
  expect(res.kind).toBe('unusable');
  if (res.kind !== 'unusable') return;
  expect(res.reason.length).toBeGreaterThan(0);
});

it('a body larger than 64 KiB is unusable with a reason, and does not throw', async () => {
  const big = JSON.stringify({ pad: 'x'.repeat(70 * 1024) });
  await expect(readInWorkspaceWith(big)).resolves.toMatchObject({ kind: 'unusable' });
  const res = await readInWorkspaceWith(big);
  expect(res.kind).toBe('unusable');
  if (res.kind !== 'unusable') return;
  expect(res.reason.length).toBeGreaterThan(0);
});

it('a valid sentinel returns ok — the positive control for the two unusable cases above', async () => {
  // Without this, "correctly classified as unusable" is indistinguishable from
  // "the reader returns unusable for everything".
  const res = await readInWorkspaceWith(
    '{"ecosystem":"pnpm","lockfileHash":"sha256:x","verified":true,"packageCount":1432}',
  );
  expect(res).toEqual({ kind: 'ok', hash: expect.stringMatching(SHA256) });
});
