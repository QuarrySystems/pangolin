import { it, expect } from 'vitest';
import { parseOutputSentinel } from '../src/sentinel-parse.js';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

it('returns not-json for bytes that are not valid JSON', () => {
  const res = parseOutputSentinel(new TextEncoder().encode('not json {'));
  expect(res).toEqual({ status: 'malformed', reason: 'not-json' });
});

it('returns not-an-object for a JSON array', () => {
  const res = parseOutputSentinel(enc([1, 2, 3]));
  expect(res).toEqual({ status: 'malformed', reason: 'not-an-object' });
});

it('returns not-an-object for a JSON string', () => {
  const res = parseOutputSentinel(enc('hello'));
  expect(res).toEqual({ status: 'malformed', reason: 'not-an-object' });
});

it('returns not-an-object for a JSON number', () => {
  const res = parseOutputSentinel(enc(42));
  expect(res).toEqual({ status: 'malformed', reason: 'not-an-object' });
});

it('returns not-an-object for JSON null', () => {
  const res = parseOutputSentinel(enc(null));
  expect(res).toEqual({ status: 'malformed', reason: 'not-an-object' });
});

it('returns bad-schema-version when schemaVersion is absent', () => {
  const res = parseOutputSentinel(enc({ patchRef: 'pangolin://ns/artifact/x' }));
  expect(res).toEqual({ status: 'malformed', reason: 'bad-schema-version' });
});

it('returns bad-schema-version when schemaVersion is not the literal 1', () => {
  const res = parseOutputSentinel(enc({ schemaVersion: 2 }));
  expect(res).toEqual({ status: 'malformed', reason: 'bad-schema-version' });
});

it('returns bad-schema-version when schemaVersion is the string "1"', () => {
  const res = parseOutputSentinel(enc({ schemaVersion: '1' }));
  expect(res).toEqual({ status: 'malformed', reason: 'bad-schema-version' });
});

it('accepts a bare sentinel with only schemaVersion set', () => {
  const res = parseOutputSentinel(enc({ schemaVersion: 1 }));
  expect(res).toEqual({ status: 'ok', sentinel: { schemaVersion: 1 } });
});

it('ignores unknown future fields', () => {
  const res = parseOutputSentinel(enc({ schemaVersion: 1, futureThing: 42 }));
  expect(res).toEqual({ status: 'ok', sentinel: { schemaVersion: 1 } });
});

it('carries patchRef and summary through when they are strings', () => {
  const res = parseOutputSentinel(
    enc({ schemaVersion: 1, patchRef: 'pangolin://ns/artifact/x', summary: 'did a thing' }),
  );
  expect(res).toEqual({
    status: 'ok',
    sentinel: { schemaVersion: 1, patchRef: 'pangolin://ns/artifact/x', summary: 'did a thing' },
  });
});

it('drops patchRef when it is not a string', () => {
  const res = parseOutputSentinel(enc({ schemaVersion: 1, patchRef: 123 }));
  expect(res).toEqual({ status: 'ok', sentinel: { schemaVersion: 1 } });
});

it('reconstructs a well-formed verify block', () => {
  const res = parseOutputSentinel(
    enc({ schemaVersion: 1, verify: { passed: true, report: 'ok', durationMs: 500 } }),
  );
  expect(res).toEqual({
    status: 'ok',
    sentinel: { schemaVersion: 1, verify: { passed: true, report: 'ok', durationMs: 500 } },
  });
});

it('drops a verify block whose passed field is not a boolean', () => {
  const res = parseOutputSentinel(enc({ schemaVersion: 1, verify: { passed: 'yes' } }));
  expect(res).toEqual({ status: 'ok', sentinel: { schemaVersion: 1 } });
});

it('truncates verify.report to exactly 16000 characters', () => {
  const longReport = 'x'.repeat(20_000);
  const res = parseOutputSentinel(
    enc({ schemaVersion: 1, verify: { passed: false, report: longReport } }),
  );
  expect(res.status).toBe('ok');
  if (res.status !== 'ok') throw new Error('unreachable');
  expect(res.sentinel.verify?.report).toHaveLength(16_000);
  expect(res.sentinel.verify?.report).toBe('x'.repeat(16_000));
});

it('drops verify.durationMs when it is not a finite number', () => {
  const res = parseOutputSentinel(
    enc({ schemaVersion: 1, verify: { passed: true, durationMs: Number.POSITIVE_INFINITY } }),
  );
  expect(res).toEqual({ status: 'ok', sentinel: { schemaVersion: 1, verify: { passed: true } } });
});

it('clamps a 300-entry outputs array to exactly 256 entries', () => {
  const entries = Array.from({ length: 300 }, (_, i) => ({
    path: `f${i}.txt`,
    ref: `pangolin://ns/artifact/${i}`,
  }));
  const res = parseOutputSentinel(enc({ schemaVersion: 1, outputs: entries }));
  expect(res.status).toBe('ok');
  if (res.status !== 'ok') throw new Error('unreachable');
  expect(res.sentinel.outputs).toHaveLength(256);
});

it('drops outputs entries missing a string path or ref', () => {
  const res = parseOutputSentinel(
    enc({
      schemaVersion: 1,
      outputs: [
        { path: 'good.txt', ref: 'pangolin://ns/artifact/1' },
        { path: 123, ref: 'pangolin://ns/artifact/2' },
        { path: 'no-ref.txt' },
        { ref: 'pangolin://ns/artifact/3' },
        null,
        'not-an-object',
      ],
    }),
  );
  expect(res).toEqual({
    status: 'ok',
    sentinel: {
      schemaVersion: 1,
      outputs: [{ path: 'good.txt', ref: 'pangolin://ns/artifact/1' }],
    },
  });
});

it('omits outputs entirely when every entry is invalid', () => {
  const res = parseOutputSentinel(enc({ schemaVersion: 1, outputs: [{ path: 123 }] }));
  expect(res).toEqual({ status: 'ok', sentinel: { schemaVersion: 1 } });
});

it('reconstructs a well-formed usage block', () => {
  const res = parseOutputSentinel(
    enc({
      schemaVersion: 1,
      usage: { models: ['claude-opus'], costUsd: 1.23, turns: 4, durationMs: 999 },
    }),
  );
  expect(res).toEqual({
    status: 'ok',
    sentinel: {
      schemaVersion: 1,
      usage: { models: ['claude-opus'], costUsd: 1.23, turns: 4, durationMs: 999 },
    },
  });
});

it('drops usage entirely when models is not an array of strings', () => {
  const res = parseOutputSentinel(enc({ schemaVersion: 1, usage: { models: 'claude-opus' } }));
  expect(res).toEqual({ status: 'ok', sentinel: { schemaVersion: 1 } });
});

it('drops non-finite usage.costUsd', () => {
  const res = parseOutputSentinel(
    enc({ schemaVersion: 1, usage: { models: ['x'], costUsd: Number.NaN } }),
  );
  expect(res).toEqual({ status: 'ok', sentinel: { schemaVersion: 1, usage: { models: ['x'] } } });
});

it('reconstructs a well-formed blocks array', () => {
  const res = parseOutputSentinel(
    enc({
      schemaVersion: 1,
      blocks: [
        {
          kind: 'edit',
          ordinal: 0,
          status: 'ok',
          exitCode: 0,
          durationMs: 100,
          patchRef: 'pangolin://ns/artifact/p',
          verify: { passed: true },
          outputs: [{ path: 'a.txt', ref: 'pangolin://ns/artifact/a' }],
        },
      ],
    }),
  );
  expect(res).toEqual({
    status: 'ok',
    sentinel: {
      schemaVersion: 1,
      blocks: [
        {
          kind: 'edit',
          ordinal: 0,
          status: 'ok',
          exitCode: 0,
          durationMs: 100,
          patchRef: 'pangolin://ns/artifact/p',
          verify: { passed: true },
          outputs: [{ path: 'a.txt', ref: 'pangolin://ns/artifact/a' }],
        },
      ],
    },
  });
});

it('drops a block entry missing required fields', () => {
  const res = parseOutputSentinel(
    enc({
      schemaVersion: 1,
      blocks: [
        { kind: 'edit', ordinal: 0, status: 'ok', durationMs: 10 },
        { kind: 'edit', status: 'ok', durationMs: 10 },
        { kind: 'edit', ordinal: 1, status: 'weird', durationMs: 10 },
        'not-an-object',
      ],
    }),
  );
  expect(res).toEqual({
    status: 'ok',
    sentinel: {
      schemaVersion: 1,
      blocks: [{ kind: 'edit', ordinal: 0, status: 'ok', durationMs: 10 }],
    },
  });
});

it('omits blocks entirely when every entry is invalid', () => {
  const res = parseOutputSentinel(enc({ schemaVersion: 1, blocks: [{ kind: 'edit' }] }));
  expect(res).toEqual({ status: 'ok', sentinel: { schemaVersion: 1 } });
});

it('returns a fresh construction unaffected by later mutation of the source object', () => {
  const source: Record<string, unknown> = {
    schemaVersion: 1,
    patchRef: 'pangolin://ns/artifact/x',
    outputs: [{ path: 'a.txt', ref: 'pangolin://ns/artifact/a' }],
  };
  const res = parseOutputSentinel(enc(source));
  source.patchRef = 'mutated';
  (source.outputs as Array<{ path: string; ref: string }>)[0].path = 'mutated.txt';
  expect(res).toEqual({
    status: 'ok',
    sentinel: {
      schemaVersion: 1,
      patchRef: 'pangolin://ns/artifact/x',
      outputs: [{ path: 'a.txt', ref: 'pangolin://ns/artifact/a' }],
    },
  });
});

it('malformed results carry only the reason enum, with no detail field', () => {
  const res = parseOutputSentinel(new TextEncoder().encode('super-secret-payload-marker'));
  expect(res.status).toBe('malformed');
  expect(Object.keys(res)).toEqual(['status', 'reason']);
  expect(JSON.stringify(res)).not.toContain('super-secret-payload-marker');
});
