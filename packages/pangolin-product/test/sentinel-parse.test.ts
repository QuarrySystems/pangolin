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

it('clamps a 300-entry blocks array to exactly 256 entries', () => {
  const blocks = Array.from({ length: 300 }, (_, i) => ({
    kind: 'edit',
    ordinal: i,
    status: 'ok',
    durationMs: 10,
  }));
  const res = parseOutputSentinel(enc({ schemaVersion: 1, blocks }));
  expect(res.status).toBe('ok');
  if (res.status !== 'ok') throw new Error('unreachable');
  expect(res.sentinel.blocks).toHaveLength(256);
});

// Note: JSON.parse defines "__proto__" as an own data property and never
// triggers the Object.prototype accessor, so prototype pollution is
// structurally unreachable via JSON input regardless of whether
// parseOutputSentinel reconstructs or forwards raw objects. This test
// guards the input path (nothing here pollutes the prototype); it does not
// prove reconstruction correctness — see the hostileExtra test below for that.
it('drops __proto__, constructor, and prototype keys without polluting Object.prototype', () => {
  const hostile = JSON.parse(
    '{"schemaVersion":1,"__proto__":{"polluted":true},"outputs":[{"path":"a.txt","ref":"pangolin://ns/artifact/a","__proto__":{"polluted":true}}],"blocks":[{"kind":"edit","ordinal":0,"status":"ok","durationMs":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}]}',
  ) as Record<string, unknown>;
  const res = parseOutputSentinel(enc(hostile));
  expect(res.status).toBe('ok');
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
});

it('clamps outputs to max entries before filtering, so 256 invalid entries followed by valid ones yield zero outputs', () => {
  const invalid = Array.from({ length: 256 }, () => ({ path: 123 }));
  const valid = Array.from({ length: 44 }, (_, i) => ({
    path: `f${i}.txt`,
    ref: `pangolin://ns/artifact/${i}`,
  }));
  const res = parseOutputSentinel(enc({ schemaVersion: 1, outputs: [...invalid, ...valid] }));
  expect(res).toEqual({ status: 'ok', sentinel: { schemaVersion: 1 } });
});

it('drops unknown extra fields when reconstructing outputs, blocks, nested block outputs, and usage — catching a raw-object-forwarding bug', () => {
  // Unlike comparing against a second, independent JSON.parse (which always
  // produces a fresh object graph regardless of whether parseOutputSentinel
  // aliases its own internal parse), this test is falsifiable: if any
  // build* helper ever pushes the raw parsed entry instead of reconstructing
  // `{ known: fields }` by hand, `hostileExtra` leaks through and toEqual
  // fails. Covers every nesting depth that has an object-reconstruction
  // step: outputs[], blocks[], blocks[].outputs[], and the usage block.
  const res = parseOutputSentinel(
    enc({
      schemaVersion: 1,
      outputs: [
        { path: 'a.txt', ref: 'pangolin://ns/artifact/d1/sha256:abc', hostileExtra: 'leak' },
      ],
      blocks: [
        {
          kind: 'edit',
          ordinal: 0,
          status: 'ok',
          durationMs: 10,
          hostileExtra: 'leak',
          outputs: [
            { path: 'b.txt', ref: 'pangolin://ns/artifact/d1/sha256:def', hostileExtra: 'leak' },
          ],
        },
      ],
      usage: { models: ['claude-opus'], hostileExtra: 'leak' },
    }),
  );

  expect(res).toEqual({
    status: 'ok',
    sentinel: {
      schemaVersion: 1,
      outputs: [{ path: 'a.txt', ref: 'pangolin://ns/artifact/d1/sha256:abc' }],
      blocks: [
        {
          kind: 'edit',
          ordinal: 0,
          status: 'ok',
          durationMs: 10,
          outputs: [{ path: 'b.txt', ref: 'pangolin://ns/artifact/d1/sha256:def' }],
        },
      ],
      usage: { models: ['claude-opus'] },
    },
  });
});

it('malformed results carry only the reason enum, with no detail field', () => {
  const res = parseOutputSentinel(new TextEncoder().encode('super-secret-payload-marker'));
  expect(res.status).toBe('malformed');
  expect(Object.keys(res)).toEqual(['status', 'reason']);
  expect(JSON.stringify(res)).not.toContain('super-secret-payload-marker');
});

// --- deps -----------------------------------------------------------------
// This parser is an allowlist reconstructor: it rebuilds named fields by hand
// and DISCARDS everything else. Without a buildDeps counterpart, `deps` is
// silently dropped on every orchestrator-side read no matter what the worker
// writes — the whole evidence chain would be inert while every other task
// passed. The first test below is the one that would catch that.

it('reconstructs a well-formed deps field', () => {
  const res = parseOutputSentinel(
    enc({
      schemaVersion: 1,
      deps: { atSetup: 'sha256:aaa', atFinish: 'sha256:bbb', tier: 'recorded' },
    }),
  );
  expect(res.status).toBe('ok');
  if (res.status !== 'ok') return;
  expect(res.sentinel.deps).toEqual({
    atSetup: 'sha256:aaa',
    atFinish: 'sha256:bbb',
    tier: 'recorded',
  });
});

it('drops deps when either hash is missing or not a string', () => {
  for (const bad of [
    { atSetup: 'sha256:a', tier: 'recorded' },
    { atFinish: 'sha256:b', tier: 'recorded' },
    { atSetup: 'sha256:a', atFinish: 123, tier: 'recorded' },
    { atSetup: null, atFinish: 'sha256:b', tier: 'recorded' },
  ]) {
    const res = parseOutputSentinel(enc({ schemaVersion: 1, deps: bad }));
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.sentinel.deps).toBeUndefined();
  }
});

it("refuses any tier other than 'recorded' — a forged 'attested' must not survive the read", () => {
  // The security property, not a typing detail: the type system cannot police
  // bytes arriving from an untrusted worker, so the runtime guard is the only
  // thing standing between a forged tier and an audit row that overclaims.
  for (const tier of ['attested', 'authority-attested', '', 'RECORDED', 1, null, undefined]) {
    const res = parseOutputSentinel(
      enc({ schemaVersion: 1, deps: { atSetup: 'sha256:a', atFinish: 'sha256:b', tier } }),
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.sentinel.deps).toBeUndefined();
  }
});

it('drops deps for non-object shapes, and omits the key entirely when absent', () => {
  for (const bad of [null, 'x', 42, [], true]) {
    const res = parseOutputSentinel(enc({ schemaVersion: 1, deps: bad }));
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.sentinel.deps).toBeUndefined();
  }
  const none = parseOutputSentinel(enc({ schemaVersion: 1 }));
  expect(none.status).toBe('ok');
  if (none.status !== 'ok') return;
  // Absent, not present-and-undefined — the sentinel is content-hashed.
  expect('deps' in none.sentinel).toBe(false);
});

it('ignores unknown sibling keys inside deps rather than forwarding them', () => {
  const res = parseOutputSentinel(
    enc({
      schemaVersion: 1,
      deps: {
        atSetup: 'sha256:a',
        atFinish: 'sha256:b',
        tier: 'recorded',
        ecosystem: 'pnpm',
        packageCount: 1432,
      },
    }),
  );
  expect(res.status).toBe('ok');
  if (res.status !== 'ok') return;
  expect(res.sentinel.deps).toEqual({
    atSetup: 'sha256:a',
    atFinish: 'sha256:b',
    tier: 'recorded',
  });
});
