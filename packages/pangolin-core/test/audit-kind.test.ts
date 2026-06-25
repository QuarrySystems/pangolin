import { it, expect } from 'vitest';
import type { AuditEntry, AuditEntryKind } from '../src/audit.js';

it("admits 'run.closed' as an AuditEntryKind and on an AuditEntry", () => {
  const kind: AuditEntryKind = 'run.closed'; // type-checks ONLY if the union member exists
  const e = { kind, runId: 'r1', at: '2026-06-25T00:00:00Z', seq: 0 } as AuditEntry;
  expect(e.kind).toBe('run.closed');
});
