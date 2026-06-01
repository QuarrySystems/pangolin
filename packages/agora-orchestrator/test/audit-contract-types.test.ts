import type { AuditExport, AuditBundle } from '../../src/contracts/audit.js';
import { it, expect } from 'vitest';

it('shapes an export and a bundle with refs only', () => {
  const exp: AuditExport = { runId: 'r1', entries: [], root: undefined, items: [{ id: 'a', status: 'done', resultRef: 'agora://artifacts/x' }] };
  expect(Object.keys(exp.items[0])).not.toContain('secret');   // refs only — no value fields
  const b: AuditBundle['runId'] = 'r1';
  expect(b).toBe('r1');
});
