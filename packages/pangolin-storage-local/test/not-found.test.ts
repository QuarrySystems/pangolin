import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalStorageProvider } from '../src/index.js';

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'pangolin-local-'));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

it('throws StorageNotFoundError for a missing blob without changing the message', async () => {
  const sp = new LocalStorageProvider({ rootDir });
  const uri = `pangolin://test/capability/ghost/sha256:${'0'.repeat(64)}`;
  await expect(sp.get(uri)).rejects.toMatchObject({ name: 'StorageNotFoundError', uri });
  await expect(sp.get(uri)).rejects.toThrow(/blob not found/i); // keeps smoke.test.ts:58-63 green
});

it('throws StorageNotFoundError for a missing dispatch record without changing the message', async () => {
  const sp = new LocalStorageProvider({ rootDir });
  const uri = 'pangolin://test/dispatches/d-missing/record.json';
  await expect(sp.get(uri)).rejects.toMatchObject({ name: 'StorageNotFoundError', uri });
  await expect(sp.get(uri)).rejects.toThrow(/not found/i); // keeps integration.test.ts:315-318 green
});
