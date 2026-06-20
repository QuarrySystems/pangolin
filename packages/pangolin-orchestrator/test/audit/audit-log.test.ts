// Unit-isolate with INLINE fakes for Signer + AuditAnchor (real impls covered elsewhere).
import { it, expect, vi } from 'vitest';
import { SqliteRunStateStore } from '../../src/runstate/sqlite.js';
import { AuditLog } from '../../src/audit/audit-log.js';
import type {
  AuditAnchor,
  AuditStore,
  AnchoredRoot,
  AnchorReceipt,
  AuditEntry,
  TimestampAuthority,
  TimestampToken,
} from '../../src/contracts/index.js';

const fakeSigner = {
  async sign() {
    return { alg: 'none', bytes: new Uint8Array(0) };
  },
};

function fakeAnchor(): AuditAnchor {
  const roots = new Map<string, AnchoredRoot>();
  return {
    id: 'fake',
    guarantee: 'detect',
    async anchor(e) {
      const r: AnchorReceipt = { anchorId: 'fake', epochId: e.epochId, guarantee: 'detect', at: 0 };
      roots.set(e.epochId, { ...e, receipt: r });
      return r;
    },
    async fetch(q) {
      const r = q.epochId ? roots.get(q.epochId) : undefined;
      return r ? [r] : [];
    },
  };
}

it('append chains entries (genesis prev empty) and sealEpoch anchors a root', async () => {
  const store = new SqliteRunStateStore();
  const anchor = fakeAnchor();
  const log = new AuditLog({ store, signer: fakeSigner, anchor });
  log.append({ runId: 'r', kind: 'run.submitted', actor: 'human:brett', at: 't0' });
  log.append({ runId: 'r', kind: 'item.fired', itemId: 'a', manifestRef: 'm', at: 't1' });
  const entries = store.getAuditEntries('r');
  expect(entries[0]!.seq).toBe(0);
  expect(entries[0]!.prevHash).toBe('');
  expect(entries[1]!.prevHash).toBe(entries[0]!.entryHash);
  const receipt = await log.sealEpoch('r');
  expect(receipt.epochId).toBe('r');
  expect((await anchor.fetch({ epochId: 'r' })).length).toBe(1);
  expect(store.getAuditRoot('r')).toBeDefined();
  expect(store.getAuditRoot('r')!.receipt.epochId).toBe('r');
});

it('seq increments per run and is independent across runs', async () => {
  const store = new SqliteRunStateStore();
  const log = new AuditLog({ store, signer: fakeSigner, anchor: fakeAnchor() });
  log.append({ runId: 'r1', kind: 'run.submitted', at: 't0' });
  log.append({ runId: 'r2', kind: 'run.submitted', at: 't0' });
  log.append({ runId: 'r1', kind: 'run.completed', at: 't1' });
  expect(store.getAuditEntries('r1').map((e) => e.seq)).toEqual([0, 1]);
  expect(store.getAuditEntries('r2').map((e) => e.seq)).toEqual([0]);
});

// A store with a throwing appendAuditEntry, to exercise the best-effort path.
function failingStore(): AuditStore {
  return {
    getAuditEntries: () => [],
    getAuditChainHead: () => '',
    appendAuditEntry: () => {
      throw new Error('store down');
    },
    putAuditRoot: () => {},
    getAuditRoot: () => undefined,
  };
}

// A failing store must not abort a tick (best-effort posture), but the drop must
// be COUNTED — silent incompleteness is a SOC2 / EU AI Act Art 12 violation.
it('tryAppend swallows a store failure without throwing', () => {
  const log = new AuditLog({ store: failingStore(), signer: fakeSigner, anchor: fakeAnchor() });
  expect(() => log.tryAppend({ runId: 'r', kind: 'run.submitted', at: 't0' })).not.toThrow();
});

it('tryAppend counts dropped appends and invokes onDrop; healthy appends keep the count at 0', () => {
  const dropped: string[] = [];
  const log = new AuditLog({
    store: failingStore(),
    signer: fakeSigner,
    anchor: fakeAnchor(),
    onDrop: (entry: Omit<AuditEntry, 'seq'>) => dropped.push(entry.kind),
  });
  expect(log.droppedAppends).toBe(0);
  log.tryAppend({ runId: 'r', kind: 'run.submitted', at: 't0' });
  log.tryAppend({ runId: 'r', kind: 'item.fired', itemId: 'a', at: 't1' });
  expect(log.droppedAppends).toBe(2);
  expect(dropped).toEqual(['run.submitted', 'item.fired']);

  const healthy = new AuditLog({
    store: new SqliteRunStateStore(),
    signer: fakeSigner,
    anchor: fakeAnchor(),
  });
  healthy.tryAppend({ runId: 'r', kind: 'run.submitted', at: 't0' });
  expect(healthy.droppedAppends).toBe(0);
});

// Compliance posture: a dropped append (incomplete audit chain) must NEVER be silent. With no
// onDrop wired, the AuditLog logs a loud completeness warning by default — an operator who forgets
// to configure surfacing still cannot miss a SOC2 CC7 / EU AI Act Art 12 violation.
it('tryAppend with no onDrop logs a loud completeness warning by default (never silent)', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const log = new AuditLog({ store: failingStore(), signer: fakeSigner, anchor: fakeAnchor() });
    log.tryAppend({ runId: 'r', kind: 'run.submitted', at: 't0' });
    expect(log.droppedAppends).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    const msg = String(spy.mock.calls[0]![0]);
    expect(msg).toMatch(/incomplete/i); // names the integrity failure
    expect(msg).toContain('run.submitted'); // includes the dropped entry kind
  } finally {
    spy.mockRestore();
  }
});

it('an explicit onDrop overrides the default loud warning (no duplicate logging)', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const dropped: string[] = [];
    const log = new AuditLog({
      store: failingStore(),
      signer: fakeSigner,
      anchor: fakeAnchor(),
      onDrop: (e: Omit<AuditEntry, 'seq'>) => dropped.push(e.kind),
    });
    log.tryAppend({ runId: 'r', kind: 'run.submitted', at: 't0' });
    expect(dropped).toEqual(['run.submitted']);
    expect(spy).not.toHaveBeenCalled(); // explicit handler suppresses the default
  } finally {
    spy.mockRestore();
  }
});

// Trusted-time wiring: a configured timestamper stamps the sealed root; its absence/failure
// must never abort the seal (best-effort posture mirroring tryAppend).
it('sealEpoch stores a trusted-time token when a timestamper is configured', async () => {
  const store = new SqliteRunStateStore();
  const token: TimestampToken = {
    alg: 'rfc3161',
    token: new Uint8Array([1, 2, 3]),
    at: '2026-01-01T00:00:00Z',
  };
  const timestamper: TimestampAuthority = {
    id: 'tsa-fake',
    async timestamp() {
      return token;
    },
  };
  const log = new AuditLog({ store, signer: fakeSigner, anchor: fakeAnchor(), timestamper });
  log.append({ runId: 'r', kind: 'run.submitted', at: 't0' });
  await log.sealEpoch('r');
  expect(store.getAuditRoot('r')!.timestamp).toEqual(token);
});

it('sealEpoch survives a throwing timestamper: seal succeeds, timestamp undefined, TSA failure surfaced honestly (not a phantom drop)', async () => {
  const store = new SqliteRunStateStore();
  const tsaErrors: Error[] = [];
  const timestamper: TimestampAuthority = {
    id: 'tsa-down',
    async timestamp() {
      throw new Error('TSA unreachable');
    },
  };
  const log = new AuditLog({
    store,
    signer: fakeSigner,
    anchor: fakeAnchor(),
    timestamper,
    onTimestampFailure: (err: Error) => tsaErrors.push(err),
  });
  log.append({ runId: 'r', kind: 'run.submitted', at: 't0' });
  const receipt = await log.sealEpoch('r'); // does NOT throw
  expect(receipt.epochId).toBe('r');
  expect(store.getAuditRoot('r')).toBeDefined(); // seal still durable
  expect(store.getAuditRoot('r')!.timestamp).toBeUndefined();
  expect(tsaErrors.length).toBe(1); // TSA outage surfaced via onTimestampFailure
  expect(tsaErrors[0]!.message).toBe('TSA unreachable');
});
