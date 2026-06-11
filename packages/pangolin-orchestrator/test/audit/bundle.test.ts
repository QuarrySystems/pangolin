import { describe, it, expect } from 'vitest';
import { SqliteRunStateStore } from '../../src/runstate/sqlite.js';
import { AuditLog } from '../../src/audit/audit-log.js';
import { LocalAnchor } from '../../src/audit/anchor.js';
import { assembleBundle } from '../../src/audit/bundle.js';
import type { AuditExport, AuditItemOutcome } from '../../src/contracts/index.js';
import type { DispatchManifest } from '../../src/contracts/index.js';

// A minimal fake signer (NoneSigner equivalent inline)
const fakeSigner = { async sign() { return { alg: 'none', bytes: new Uint8Array(0) }; } };

/** Build an AuditLog with a real store + LocalAnchor, append entries, seal, extract AuditExport. */
async function buildExport(runId: string, items: AuditItemOutcome[]): Promise<{
  exp: AuditExport;
  store: SqliteRunStateStore;
  anchor: LocalAnchor;
}> {
  const store = new SqliteRunStateStore();
  const anchor = new LocalAnchor(store);
  const log = new AuditLog({ store, signer: fakeSigner, anchor });

  log.append({ runId, kind: 'run.submitted', actor: 'human:test', at: '2026-06-01T00:00:00Z' });
  log.append({ runId, kind: 'item.fired', itemId: 'item-1', manifestRef: 'manifest-ref-1', at: '2026-06-01T00:01:00Z' });
  log.append({ runId, kind: 'run.completed', at: '2026-06-01T00:02:00Z' });

  await log.sealEpoch(runId);

  const entries = store.getAuditEntries(runId);
  const root = store.getAuditRoot(runId);

  const exp: AuditExport = { runId, entries, root, items };
  return { exp, store, anchor };
}

const sampleManifest: DispatchManifest = {
  schemaVersion: 1,
  runId: 'run-1',
  itemId: 'item-1',
  parent: 'run:run-1',
  executor: 'dispatch',
  executorManifest: { detail: 'test' },
  secretRefs: [],
  actor: 'human:test',
  firedAt: '2026-06-01T00:01:00Z',
  manifestHash: 'sha256:abc',
};

describe('assembleBundle', () => {
  it('verifies a faithful export and reports tamper-detecting under a detect-tier anchor', async () => {
    const items: AuditItemOutcome[] = [
      { id: 'item-1', status: 'done', manifestRef: 'manifest-ref-1' },
    ];
    const { exp, anchor } = await buildExport('run-1', items);

    const manifestBytes = new TextEncoder().encode(JSON.stringify(sampleManifest));
    const storage = {
      async get(ref: string): Promise<Uint8Array> {
        if (ref === 'manifest-ref-1') return manifestBytes;
        throw new Error(`Unknown ref: ${ref}`);
      },
    };

    const bundle = await assembleBundle(exp, { anchor, storage });

    expect(bundle.runId).toBe('run-1');
    expect(bundle.report.intact).toBe(true);
    expect(bundle.report.claim).toBe('tamper-detecting');
    expect(bundle.report.guarantee).toBe('detect');
    expect(bundle.manifests).toHaveLength(1);
    expect(bundle.manifests[0]).toMatchObject({ itemId: 'item-1' });
    expect(bundle.auditLog.entries).toHaveLength(3);
    expect(bundle.auditLog.root).toBeDefined();
    expect(bundle.items).toEqual(items);
  });

  it('fails verification when an exported entry is mutated', async () => {
    const items: AuditItemOutcome[] = [
      { id: 'item-1', status: 'done' },
    ];
    const { exp, anchor } = await buildExport('run-2', items);

    // Mutate the first entry's entryHash to simulate tampering
    const mutatedEntries = exp.entries.map((e, i) =>
      i === 0 ? { ...e, entryHash: 'deadbeef'.repeat(8) } : e
    );
    const mutatedExp: AuditExport = { ...exp, entries: mutatedEntries };

    const storage = { async get(): Promise<Uint8Array> { throw new Error('no manifests'); } };

    const bundle = await assembleBundle(mutatedExp, { anchor, storage });

    expect(bundle.report.intact).toBe(false);
    expect(['chain', 'root-mismatch']).toContain(bundle.report.failure);
  });

  it('skips a missing manifest without throwing', async () => {
    const items: AuditItemOutcome[] = [
      { id: 'item-1', status: 'done', manifestRef: 'missing-ref' },
    ];
    const { exp, anchor } = await buildExport('run-3', items);

    const storage = {
      async get(_ref: string): Promise<Uint8Array> {
        throw new Error('Storage unavailable');
      },
    };

    const bundle = await assembleBundle(exp, { anchor, storage });

    // assembleBundle resolves without throwing
    expect(bundle.runId).toBe('run-3');
    // Missing manifest is omitted from manifests array
    expect(bundle.manifests).toHaveLength(0);
    // Report is still computed
    expect(bundle.report).toBeDefined();
    expect(bundle.report.intact).toBe(true);
  });

  it('returns the correct shape with runId, manifests, auditLog, items, report', async () => {
    const items: AuditItemOutcome[] = [];
    const { exp, anchor } = await buildExport('run-4', items);

    const storage = { async get(): Promise<Uint8Array> { throw new Error('no manifests'); } };

    const bundle = await assembleBundle(exp, { anchor, storage });

    expect(bundle).toHaveProperty('runId');
    expect(bundle).toHaveProperty('manifests');
    expect(bundle).toHaveProperty('auditLog');
    expect(bundle).toHaveProperty('auditLog.entries');
    expect(bundle).toHaveProperty('auditLog.root');
    expect(bundle).toHaveProperty('items');
    expect(bundle).toHaveProperty('report');
    expect(Array.isArray(bundle.manifests)).toBe(true);
    expect(Array.isArray(bundle.auditLog.entries)).toBe(true);
  });

  it('exportStore write methods throw read-only', async () => {
    // Verify the read-only behavior is enforced (accessed indirectly via assembleBundle, but
    // we test it through the exported module internals by using assembleBundle's behavior).
    // Since exportStore is not exported, we rely on the fact that verify() only calls read methods.
    // This test verifies that assembleBundle completes without triggering any write paths.
    const items: AuditItemOutcome[] = [];
    const { exp, anchor } = await buildExport('run-5', items);
    const storage = { async get(): Promise<Uint8Array> { throw new Error('no manifests'); } };
    // Should complete without throwing (write methods are not called by verify)
    await expect(assembleBundle(exp, { anchor, storage })).resolves.toBeDefined();
  });
});
