import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MailboxStore } from '../contracts/index.js';

/**
 * Characters illegal in Windows filenames that must be percent-encoded in each
 * path segment. We leave '/' alone — it stays the directory delimiter.
 *
 * '%' itself is included so that the encoding is injective: a literal '%3A' in
 * a key is stored as '%253A', which cannot collide with ':' stored as '%3A'.
 * Without '%' in this set, decodeURIComponent in decodeSegment would also throw
 * on a malformed '%XX' sequence when round-tripping through list().
 */
// Intentionally encodes ASCII control chars (\x00-\x1f) so they never reach a filename.
// eslint-disable-next-line no-control-regex
const ENCODE_RE = /[%<>:"|?*\x00-\x1f\\]/g;

function encodeSegment(segment: string): string {
  return segment.replace(ENCODE_RE, (ch) => {
    return '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  });
}

function decodeSegment(segment: string): string {
  return decodeURIComponent(segment);
}

/** Convert a logical key to an OS filesystem path under root. */
function keyToPath(root: string, key: string): string {
  const parts = key.split('/').map(encodeSegment);
  return join(root, ...parts);
}

/** Convert an absolute filesystem path under root back to its logical key. */
function pathToKey(root: string, filePath: string): string {
  // Remove root prefix + leading sep
  const rel = filePath.slice(root.length).replace(/^[/\\]/, '');
  // Split on both / and \ to handle any OS
  const parts = rel.split(/[/\\]/);
  return parts.map(decodeSegment).join('/');
}

/** Recursively yield all file paths under a directory. */
async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else {
      yield full;
    }
  }
}

/**
 * Filesystem-backed MailboxStore.
 *
 * Keys are '/'-delimited logical paths. Windows-illegal characters in each
 * segment are percent-encoded so keys like `outbox/r/2026-01-01T00:00:00Z.json`
 * are safely storable on every OS.
 *
 * Writes are crash-safe: data goes to a temp file, then renamed over the target.
 * The temp suffix uses a per-instance incrementing counter (no Date.now / Math.random).
 */
export class LocalDirMailbox implements MailboxStore {
  private counter = 0;

  constructor(private readonly root: string) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = keyToPath(this.root, key);
    const tmpPath = `${target}.${this.counter++}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmpPath, bytes);
    try {
      await rename(tmpPath, target);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const filePath = keyToPath(this.root, key);
    try {
      const buf = await readFile(filePath);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    // Normalise the prefix so matching is segment-boundary-safe:
    // a key matches iff it IS the prefix exactly OR it starts with
    // the prefix followed by '/'.  This prevents 'out' from matching
    // 'outbox/...' when the caller intended a directory scope.
    const dirPrefix = prefix.endsWith('/') ? prefix : prefix + '/';
    const results: string[] = [];
    for await (const filePath of walkFiles(this.root)) {
      const logicalKey = pathToKey(this.root, filePath);
      if (logicalKey === prefix || logicalKey.startsWith(dirPrefix)) {
        results.push(logicalKey);
      }
    }
    return results;
  }

  async delete(key: string): Promise<void> {
    const filePath = keyToPath(this.root, key);
    try {
      await unlink(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }
}
