import { AuditLog, LocalAnchor, S3ObjectLockAnchor, createLocalSigner, NoneSigner, verify, verifyEd25519 } from '../src/index.js';
import { it, expect } from 'vitest';
it('exposes the audit primitives from the package root', () => {
  expect(typeof AuditLog).toBe('function');
  expect(typeof LocalAnchor).toBe('function');
  expect(typeof S3ObjectLockAnchor).toBe('function');
  expect(typeof createLocalSigner).toBe('function');
  expect(typeof verify).toBe('function');
  expect(typeof verifyEd25519).toBe('function');
  expect(NoneSigner).toBeDefined();
});
