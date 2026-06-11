import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { merkleRoot, chainHash, leavesFromEntryHashes } from '../../src/audit/merkle.js';
import { canonEntry } from '../../src/audit/canon.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const vectorDir = resolve(__dirname, '../conformance/audit-vectors');

const merkleEmpty = JSON.parse(readFileSync(resolve(vectorDir, 'merkle-empty.json'), 'utf8'));
const merkleOdd = JSON.parse(readFileSync(resolve(vectorDir, 'merkle-odd.json'), 'utf8'));
const chainBasic = JSON.parse(readFileSync(resolve(vectorDir, 'chain-basic.json'), 'utf8'));

it('empty tree = 32 zero bytes (matches vector)', () => {
  expect(Buffer.from(merkleRoot([])).toString('hex')).toBe('00'.repeat(32));
  expect(Buffer.from(merkleRoot([])).toString('hex')).toBe(merkleEmpty.root);
});

it('odd leaf count carries up the last node (matches frozen vector root)', () => {
  const leaves = (merkleOdd.leavesHex as string[]).map((h: string) => Uint8Array.from(Buffer.from(h, 'hex')));
  expect(Buffer.from(merkleRoot(leaves)).toString('hex')).toBe(merkleOdd.root);
});

it('chain hashes match the frozen chain-basic vector (genesis prev empty)', () => {
  let prev = '';
  for (const step of chainBasic.steps as Array<{ entry: any; expectedEntryHash: string }>) {
    const h = chainHash(canonEntry(step.entry), prev);
    expect(h).toBe(step.expectedEntryHash);
    prev = h;
  }
});

describe('canonEntry field order', () => {
  it('emits positional array with nulls for absent optional fields', () => {
    const entry = { runId: 'r1', seq: 5, kind: 'run.completed' as const, at: '2026-01-01T00:00:00.000Z' };
    const parsed = JSON.parse(canonEntry(entry));
    expect(parsed).toEqual(['run.completed', 'r1', null, null, null, null, null, '2026-01-01T00:00:00.000Z', 5]);
  });

  it('emits present optional fields at their correct positions', () => {
    const entry = {
      runId: 'r2', seq: 3, kind: 'item.fired' as const, at: '2026-01-01T00:01:00.000Z',
      itemId: 'i1', status: 'done', actor: 'a1', manifestRef: 'mref', resultRef: 'rref',
    };
    const parsed = JSON.parse(canonEntry(entry));
    expect(parsed).toEqual(['item.fired', 'r2', 'i1', 'done', 'a1', 'mref', 'rref', '2026-01-01T00:01:00.000Z', 3]);
  });
});

describe('merkleRoot internals', () => {
  it('single leaf = SHA256(0x00 || leaf)', () => {
    const leaf = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    const expected = createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), leaf])).digest('hex');
    expect(Buffer.from(merkleRoot([leaf])).toString('hex')).toBe(expected);
  });

  it('two leaves = SHA256(0x01 || leaf0hash || leaf1hash)', () => {
    const leaf0 = Uint8Array.from([0xaa]);
    const leaf1 = Uint8Array.from([0xbb]);
    const h0 = new Uint8Array(createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), leaf0])).digest());
    const h1 = new Uint8Array(createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), leaf1])).digest());
    const expected = createHash('sha256').update(Buffer.concat([Buffer.from([0x01]), h0, h1])).digest('hex');
    expect(Buffer.from(merkleRoot([leaf0, leaf1])).toString('hex')).toBe(expected);
  });
});

describe('leavesFromEntryHashes', () => {
  it('decodes hex strings to raw Uint8Arrays', () => {
    const result = leavesFromEntryHashes(['aabb', 'ccdd']);
    expect(result[0]).toEqual(Uint8Array.from([0xaa, 0xbb]));
    expect(result[1]).toEqual(Uint8Array.from([0xcc, 0xdd]));
  });
});
