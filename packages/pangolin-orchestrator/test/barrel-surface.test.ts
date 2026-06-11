// packages/pangolin-orchestrator/test/barrel-surface.test.ts
// Verifies that newly wired barrel exports are reachable from the package root.
import { OperationsApi, assembleBundle, PRIVILEGE, validateRun, normalizeRun, resolveInputRefs, selectProductRef } from '../src/index.js';
import type { OperationsApiDeps, AuditExport, AuditBundle, ControlChannel } from '../src/index.js';
import { it, expect } from 'vitest';

it('exposes OperationsApi, assembleBundle, and PRIVILEGE from the package root', () => {
  expect(typeof OperationsApi).toBe('function');     // class
  expect(typeof assembleBundle).toBe('function');
  expect(PRIVILEGE.submit?.mcp).toBe(true);          // formalized registry reachable
  // type-only imports (OperationsApiDeps, AuditExport, AuditBundle, ControlChannel) compile = reachable
});

it('exposes validateRun, normalizeRun, resolveInputRefs, selectProductRef from the package root', () => {
  expect(typeof validateRun).toBe('function');
  expect(typeof normalizeRun).toBe('function');
  expect(typeof resolveInputRefs).toBe('function');
  expect(typeof selectProductRef).toBe('function');
});
