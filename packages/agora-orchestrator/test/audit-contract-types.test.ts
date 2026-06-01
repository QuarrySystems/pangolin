import type { AuditExport, AuditBundle } from '../../src/contracts/audit.js';
import { it, expect } from 'vitest';

it('shapes an export and a bundle with refs only', () => {
  const exp: AuditExport = { runId: 'r1', entries: [], root: undefined, items: [{ id: 'a', status: 'done', resultRef: 'agora://artifacts/x' }] };
  expect(Object.keys(exp.items[0])).not.toContain('secret');   // refs only — no value fields
  const b: AuditBundle['runId'] = 'r1';
  expect(b).toBe('r1');
});

it('shapes a full AuditBundle (all five fields, refs only)', () => {
  const bundle: AuditBundle = {
    runId: 'r1',
    manifests: [],
    auditLog: { entries: [], root: undefined },
    items: [{ id: 'a', status: 'done', resultRef: 'agora://artifacts/x' }],
    report: { runId: 'r1', intact: true, anchorId: 'anc1', guarantee: 'detect', claim: 'tamper-detecting' },
  };
  expect(bundle.report.claim).toBe('tamper-detecting');
  expect(bundle.manifests).toEqual([]);
});
