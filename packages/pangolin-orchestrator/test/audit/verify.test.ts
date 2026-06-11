import { describe, it, expect } from 'vitest';
import { SqliteRunStateStore } from '../../src/runstate/sqlite.js';
import { canonEntry } from '../../src/audit/canon.js';
import { chainHash, merkleRoot, leavesFromEntryHashes } from '../../src/audit/merkle.js';
import { verify, claimFor } from '../../src/audit/verify.js';

function seed(store: SqliteRunStateStore, runId: string) {
  const mk = (e: any, prev: string) => {
    const eh = chainHash(canonEntry({ ...e, runId }), prev);
    store.appendAuditEntry({ ...e, runId, entryHash: eh, prevHash: prev });
    return eh;
  };
  const h0 = mk({ seq: 0, kind: 'run.submitted', at: 't0' }, '');
  const h1 = mk({ seq: 1, kind: 'run.completed', at: 't1' }, h0);
  return merkleRoot(leavesFromEntryHashes([h0, h1]));
}

const anchorOf = (root: Uint8Array, guarantee = 'detect' as const) => ({
  id: 'fake',
  guarantee,
  async anchor() {
    return { anchorId: 'fake', epochId: 'r', guarantee, at: 0 };
  },
  async fetch() {
    return [{ epochId: 'r', root, receipt: { anchorId: 'fake', epochId: 'r', guarantee, at: 0 } }];
  },
});

it('clean run intact; detect anchor -> tamper-detecting', async () => {
  const store = new SqliteRunStateStore();
  const root = seed(store, 'r');
  expect(await verify('r', { store, anchor: anchorOf(root) })).toMatchObject({
    intact: true,
    guarantee: 'detect',
    claim: 'tamper-detecting',
  });
});

it('external-immutable anchor on a clean run -> tamper-evident', async () => {
  const store = new SqliteRunStateStore();
  const root = seed(store, 'r');
  expect((await verify('r', { store, anchor: anchorOf(root, 'external-immutable') })).claim).toBe(
    'tamper-evident',
  );
});

it('mutating a persisted entry fails verification (chain)', async () => {
  const store = new SqliteRunStateStore();
  const root = seed(store, 'r');
  (store as any).db
    .prepare("UPDATE audit_entries SET actor='attacker' WHERE run_id='r' AND seq=0")
    .run();
  const r = await verify('r', { store, anchor: anchorOf(root) });
  expect(r.intact).toBe(false);
  expect(r.claim).toBe('tamper-detecting');
  expect(r.failure).toBe('chain');
});

it('root-mismatch when the anchored root differs from the recomputed root', async () => {
  const store = new SqliteRunStateStore();
  seed(store, 'r');
  const r = await verify('r', { store, anchor: anchorOf(new Uint8Array(32).fill(0xab)) });
  expect(r.failure).toBe('root-mismatch');
});

it('bad signature -> failure signature', async () => {
  const store = new SqliteRunStateStore();
  const root = seed(store, 'r');
  const anchor = {
    id: 'fake',
    guarantee: 'external-immutable' as const,
    async anchor() {
      return {} as any;
    },
    async fetch() {
      return [
        {
          epochId: 'r',
          root,
          signature: { alg: 'ed25519', bytes: new Uint8Array([9]) },
          receipt: { anchorId: 'fake', epochId: 'r', guarantee: 'external-immutable' as const, at: 0 },
        },
      ];
    },
  };
  const r = await verify('r', { store, anchor, verifySignature: () => false });
  expect(r.failure).toBe('signature');
});

it('missing anchored root -> anchor-missing', async () => {
  const store = new SqliteRunStateStore();
  seed(store, 'r');
  const empty = {
    id: 'x',
    guarantee: 'detect' as const,
    async anchor() {
      return {} as any;
    },
    async fetch() {
      return [];
    },
  };
  expect((await verify('r', { store, anchor: empty })).failure).toBe('anchor-missing');
});

it('a run with zero entries verifies against the 32-zero-byte root', async () => {
  const store = new SqliteRunStateStore();
  const zeroRoot = new Uint8Array(32);
  const anchor = {
    id: 'fake',
    guarantee: 'detect' as const,
    async anchor() {
      return {} as any;
    },
    async fetch() {
      return [{ epochId: 'empty', root: zeroRoot, receipt: { anchorId: 'fake', epochId: 'empty', guarantee: 'detect' as const, at: 0 } }];
    },
  };
  const r = await verify('empty', { store, anchor });
  expect(r.intact).toBe(true);
});

it('signature present but no verifySignature supplied -> intact (signature check skipped)', async () => {
  const store = new SqliteRunStateStore();
  const root = seed(store, 'sig-skip');
  const anchor = {
    id: 'fake',
    guarantee: 'detect' as const,
    async anchor() {
      return {} as any;
    },
    async fetch() {
      return [
        {
          epochId: 'sig-skip',
          root,
          signature: { alg: 'ed25519', bytes: new Uint8Array([1, 2, 3]) },
          receipt: { anchorId: 'fake', epochId: 'sig-skip', guarantee: 'detect' as const, at: 0 },
        },
      ];
    },
  };
  const r = await verify('sig-skip', { store, anchor });
  expect(r.intact).toBe(true);
  expect(r.failure).toBeUndefined();
});

it('clean external-immutable run: all four checks ok', async () => {
  const store = new SqliteRunStateStore();
  const root = seed(store, 'r');
  const r = await verify('r', { store, anchor: anchorOf(root, 'external-immutable') });
  expect(r.checks.chain.ok).toBe(true);
  expect(r.checks.root.ok).toBe(true);
  expect(r.checks.anchor.ok).toBe(true);
  expect(r.checks.signature.ok).toBe('n/a');
});

it('tampered entry: chain check fails and names the seq; anchor still evaluated (collect-all)', async () => {
  const store = new SqliteRunStateStore();
  const root = seed(store, 'r2');
  (store as any).db
    .prepare("UPDATE audit_entries SET actor='attacker' WHERE run_id='r2' AND seq=0")
    .run();
  const r = await verify('r2', { store, anchor: anchorOf(root) });
  expect(r.checks.chain.ok).toBe(false);
  expect(r.checks.chain.detail).toContain('0');
  expect(r.checks.anchor.ok).toBe(true);   // no early return — anchor was fetched
  expect(r.failure).toBe('chain');         // back-compat preserved
});

it('no anchor: checks.root.ok === n/a, checks.signature.ok === n/a', async () => {
  const store = new SqliteRunStateStore();
  seed(store, 'r3');
  const empty = {
    id: 'x',
    guarantee: 'detect' as const,
    async anchor() { return {} as any; },
    async fetch() { return []; },
  };
  const r = await verify('r3', { store, anchor: empty });
  expect(r.checks.root.ok).toBe('n/a');
  expect(r.checks.signature.ok).toBe('n/a');
  expect(r.checks.anchor.ok).toBe(false);
  expect(r.failure).toBe('anchor-missing');
});

it('bare verify: checks.handoff.ok === n/a', async () => {
  const store = new SqliteRunStateStore();
  const root = seed(store, 'r-handoff');
  const r = await verify('r-handoff', { store, anchor: anchorOf(root) });
  expect(r.checks.handoff.ok).toBe('n/a');
});

describe('claimFor', () => {
  it('intact + external-immutable -> tamper-evident', () => {
    expect(claimFor(true, 'external-immutable')).toBe('tamper-evident');
  });

  it('not intact + external-immutable -> tamper-detecting', () => {
    expect(claimFor(false, 'external-immutable')).toBe('tamper-detecting');
  });

  it('intact + detect -> tamper-detecting', () => {
    expect(claimFor(true, 'detect')).toBe('tamper-detecting');
  });
});
