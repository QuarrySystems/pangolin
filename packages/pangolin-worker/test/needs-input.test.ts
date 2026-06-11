// Tests for the worker's needs_input sentinel resolver (§6.9 step 11).
//
// The resolver consumes `RuntimeExit.needsInputSentinelPath` (the absolute
// path the runtime adapter reports when it observed the sentinel) and
// produces a discriminated outcome describing whether the file was valid,
// malformed, or oversized per ADR-0009.

import { resolveNeedsInputSentinel } from '../src/needs-input.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, beforeEach, afterEach, describe } from 'vitest';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ni-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(payload: unknown | string): Promise<string> {
  const p = join(dir, 'needs_input.json');
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  await writeFile(p, body, 'utf-8');
  return p;
}

describe('resolveNeedsInputSentinel', () => {
  it('returns needs_input for a valid minimal sentinel (question only)', async () => {
    const p = await write({ question: 'Need API key?' });
    const out = await resolveNeedsInputSentinel(p);
    expect(out.kind).toBe('needs_input');
    if (out.kind !== 'needs_input') throw new Error('narrowing');
    expect(out.payload.question).toBe('Need API key?');
    expect(out.payload.options).toBeUndefined();
    expect(out.payload.context).toBeUndefined();
    expect(out.payload.partialState).toBeUndefined();
  });

  it('passes through options, context, and partialState (renaming partial_state)', async () => {
    const p = await write({
      question: 'Pick one',
      options: ['a', 'b'],
      context: 'see logs',
      partial_state: { cursor: 17, note: 'draft' },
    });
    const out = await resolveNeedsInputSentinel(p);
    expect(out.kind).toBe('needs_input');
    if (out.kind !== 'needs_input') throw new Error('narrowing');
    expect(out.payload.options).toEqual(['a', 'b']);
    expect(out.payload.context).toBe('see logs');
    expect(out.payload.partialState).toEqual({ cursor: 17, note: 'draft' });
  });

  it('returns malformed when the file is missing on disk', async () => {
    const out = await resolveNeedsInputSentinel(join(dir, 'does-not-exist.json'));
    expect(out.kind).toBe('malformed');
    if (out.kind !== 'malformed') throw new Error('narrowing');
    expect(out.detail).toMatch(/does-not-exist\.json/);
  });

  it('returns malformed when the file is not valid JSON', async () => {
    const p = await write('not-json{');
    const out = await resolveNeedsInputSentinel(p);
    expect(out.kind).toBe('malformed');
    if (out.kind !== 'malformed') throw new Error('narrowing');
    expect(out.detail).toMatch(/parse/i);
  });

  it("returns malformed when 'question' is missing", async () => {
    const p = await write({ context: 'x' });
    const out = await resolveNeedsInputSentinel(p);
    expect(out.kind).toBe('malformed');
    if (out.kind !== 'malformed') throw new Error('narrowing');
    expect(out.detail).toMatch(/question/);
  });

  it("returns malformed when 'question' is the empty string", async () => {
    const p = await write({ question: '' });
    const out = await resolveNeedsInputSentinel(p);
    expect(out.kind).toBe('malformed');
    if (out.kind !== 'malformed') throw new Error('narrowing');
    expect(out.detail).toMatch(/question/);
  });

  it("returns malformed when 'question' is not a string", async () => {
    const p = await write({ question: 42 });
    const out = await resolveNeedsInputSentinel(p);
    expect(out.kind).toBe('malformed');
  });

  it('returns oversized when canonical partial_state exceeds 1 MiB', async () => {
    const p = await write({
      question: 'q',
      partial_state: { big: 'x'.repeat(2 * 1024 * 1024) },
    });
    const out = await resolveNeedsInputSentinel(p);
    expect(out.kind).toBe('oversized');
    if (out.kind !== 'oversized') throw new Error('narrowing');
    expect(out.sizeBytes).toBeGreaterThan(1024 * 1024);
  });

  it('accepts partial_state at exactly 1 MiB canonical size', async () => {
    // Construct a payload whose canonical JSON size is exactly 1 MiB.
    // Canonical form of {"v":"<str>"} is 8 chars + str length; pick str
    // length so total === 1 MiB.
    const overhead = '{"v":""}'.length; // 8
    const strLen = 1024 * 1024 - overhead;
    const p = await write({
      question: 'q',
      partial_state: { v: 'x'.repeat(strLen) },
    });
    const out = await resolveNeedsInputSentinel(p);
    expect(out.kind).toBe('needs_input');
  });

  it('omits the partial_state size check when partial_state is absent', async () => {
    // A sentinel with no partial_state must not error out attempting to size it.
    const p = await write({ question: 'q', context: 'ctx' });
    const out = await resolveNeedsInputSentinel(p);
    expect(out.kind).toBe('needs_input');
  });

  it('sorts object keys recursively for canonical sizing (regression for key-order drift)', async () => {
    // Two payloads with same content but different key orders must size identically.
    // We can only observe this indirectly: build a payload whose canonical size
    // sits just under 1 MiB and verify both orderings accept.
    const overhead = '{"a":"","b":""}'.length; // 16
    const half = Math.floor((1024 * 1024 - overhead) / 2);
    const pA = await write({
      question: 'q',
      partial_state: { a: 'x'.repeat(half), b: 'y'.repeat(half) },
    });
    const outA = await resolveNeedsInputSentinel(pA);
    expect(outA.kind).toBe('needs_input');
    // Same content, reversed insertion order.
    const reversed: Record<string, string> = {};
    reversed.b = 'y'.repeat(half);
    reversed.a = 'x'.repeat(half);
    const pB = await write({ question: 'q', partial_state: reversed });
    const outB = await resolveNeedsInputSentinel(pB);
    expect(outB.kind).toBe('needs_input');
  });
});
