// Per-test scratch directory helper for `LocalStorageProvider`.
//
// `useTempStorageRoot(prefix)` wires `beforeEach` / `afterEach` into the
// surrounding vitest scope so each test gets a fresh `mkdtemp`'d directory
// and the directory is removed after the test completes. The returned
// closure captures the latest path on every invocation — callers must call
// it inside the test body (NOT at module load), otherwise they will see
// the empty initial value.
//
// Usage:
//   const getRoot = useTempStorageRoot('e2e-happy-path');
//   it('does the thing', async () => {
//     const client = makeClient({ namespace: 'x', storageRoot: getRoot() });
//   });

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach } from 'vitest';

export function useTempStorageRoot(prefix: string): () => string {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), `${prefix}-`));
  });
  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = '';
    }
  });
  return () => root;
}
