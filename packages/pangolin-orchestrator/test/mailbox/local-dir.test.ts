import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDirMailbox } from '../../src/mailbox/local-dir.js';

async function mkRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mbox-'));
}

describe('LocalDirMailbox', () => {
  it('put then get round-trips bytes', async () => {
    const root = await mkRoot();
    try {
      const m = new LocalDirMailbox(root);
      const data = new TextEncoder().encode('hello world');
      await m.put('some/key', data);
      const result = await m.get('some/key');
      expect(result).not.toBeNull();
      expect(new TextDecoder().decode(result!)).toBe('hello world');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('get of an absent key returns null', async () => {
    const root = await mkRoot();
    try {
      const m = new LocalDirMailbox(root);
      const result = await m.get('no/such/key');
      expect(result).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('list returns logical keys matching prefix', async () => {
    const root = await mkRoot();
    try {
      const m = new LocalDirMailbox(root);
      await m.put('outbox/a/1.json', new TextEncoder().encode('1'));
      await m.put('outbox/a/2.json', new TextEncoder().encode('2'));
      await m.put('inbox/b/3.json', new TextEncoder().encode('3'));

      const outboxKeys = await m.list('outbox/');
      expect(outboxKeys).toHaveLength(2);
      expect(outboxKeys).toContain('outbox/a/1.json');
      expect(outboxKeys).toContain('outbox/a/2.json');
      expect(outboxKeys).not.toContain('inbox/b/3.json');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('delete removes the key', async () => {
    const root = await mkRoot();
    try {
      const m = new LocalDirMailbox(root);
      await m.put('to/delete', new TextEncoder().encode('bye'));
      await m.delete('to/delete');
      const result = await m.get('to/delete');
      expect(result).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('delete is idempotent (no-op if absent)', async () => {
    const root = await mkRoot();
    try {
      const m = new LocalDirMailbox(root);
      // Should not throw
      await expect(m.delete('does/not/exist')).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('list on absent root returns []', async () => {
    // Use a root that does not exist
    const root = join(tmpdir(), `mbox-nonexistent-${Date.now()}`);
    const m = new LocalDirMailbox(root);
    const result = await m.list('any/');
    expect(result).toEqual([]);
  });

  it('round-trips a key containing a colon (Windows-illegal char)', async () => {
    const root = await mkRoot();
    try {
      const m = new LocalDirMailbox(root);
      const k = 'outbox/r/2026-01-01T00:00:00Z.json';
      await m.put(k, new TextEncoder().encode('x'));
      const keys = await m.list('outbox/');
      expect(keys).toContain(k);
      const bytes = await m.get(k);
      expect(bytes).not.toBeNull();
      expect(new TextDecoder().decode(bytes!)).toBe('x');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('put overwrites existing key', async () => {
    const root = await mkRoot();
    try {
      const m = new LocalDirMailbox(root);
      await m.put('key', new TextEncoder().encode('first'));
      await m.put('key', new TextEncoder().encode('second'));
      const bytes = await m.get('key');
      expect(new TextDecoder().decode(bytes!)).toBe('second');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keys with literal %3A and : do not collide and list() returns both original keys', async () => {
    const root = await mkRoot();
    try {
      const m = new LocalDirMailbox(root);
      const keyWithPercent = 'a/x%3Ay.json';   // literal percent-three-A
      const keyWithColon  = 'a/x:y.json';      // colon — encodes to %3A at filesystem level

      await m.put(keyWithPercent, new TextEncoder().encode('percent'));
      await m.put(keyWithColon,   new TextEncoder().encode('colon'));

      // Values must be distinct (no collision)
      const pBytes = await m.get(keyWithPercent);
      const cBytes = await m.get(keyWithColon);
      expect(new TextDecoder().decode(pBytes!)).toBe('percent');
      expect(new TextDecoder().decode(cBytes!)).toBe('colon');

      // list() must return both original logical keys, no crash
      const keys = await m.list('a/');
      expect(keys).toContain(keyWithPercent);
      expect(keys).toContain(keyWithColon);
      expect(keys).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('list(prefix) does not match keys that only share a prefix string but not a segment boundary', async () => {
    const root = await mkRoot();
    try {
      const m = new LocalDirMailbox(root);
      await m.put('outbox/a.json', new TextEncoder().encode('1'));
      await m.put('outbox2/b.json', new TextEncoder().encode('2'));

      // Bare prefix 'out' must NOT match 'outbox/...' or 'outbox2/...'
      const bareResults = await m.list('out');
      expect(bareResults).toHaveLength(0);

      // 'outbox' (no trailing slash) must NOT match 'outbox2/...'
      const noSlashResults = await m.list('outbox');
      // Should only contain 'outbox/a.json' (exact directory match) or nothing,
      // but must NOT include 'outbox2/b.json'
      expect(noSlashResults).not.toContain('outbox2/b.json');

      // Proper trailing-slash prefix still works
      const slashResults = await m.list('outbox/');
      expect(slashResults).toContain('outbox/a.json');
      expect(slashResults).not.toContain('outbox2/b.json');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
