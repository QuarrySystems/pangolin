// @quarry-systems/pangolin-storage-local
//
// `LocalStorageProvider` implements the `StorageProvider` contract against a
// local filesystem directory. The on-disk layout mirrors the pangolin URI:
//
//   pangolin://<namespace>/<type>/<name>/<contentHash>
//     -> <root>/<namespace>/<type>/<name>/<contentHash>.blob
//
// Per-(namespace, type, name) registry of registered blobs lives at
//   <root>/<namespace>/<type>/<name>/_index.json
// and is the source of truth for `resolveLatest` / `list`.
//
// Dispatch records (URIs under the reserved `dispatches/` prefix, per §7.8
// and `buildDispatchRecordUri`) take a separate code path: they are NOT
// content-addressed, so each URI maps directly to a single on-disk file with
// no `_index.json` and no hash-suffixed `.blob` filename:
//
//   pangolin://<namespace>/dispatches/<dispatchId>[/<suffix>]
//     -> <root>/<namespace>/dispatches/<dispatchId>[/<suffix>]
//
// `parseStorageUri` from pangolin-core is the permissive parser that accepts
// both shapes. The general `parsePangolinUri` still rejects `dispatches` as a
// client-side write-safety guard.

import { writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import { join, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  parseStorageUri,
  buildPangolinUri,
  computeContentHash,
  IntegrityMismatchError,
  type StorageProvider,
  type PangolinUriParts,
  type StorageUriParts,
} from '@quarry-systems/pangolin-core';

export interface LocalStorageProviderOpts {
  rootDir: string;
}

interface IndexEntry {
  contentHash: string;
  registeredAt: string;
}

interface IndexFile {
  entries: IndexEntry[];
}

function emptyIndex(): IndexFile {
  return { entries: [] };
}

export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local-fs';

  /**
   * Per-indexPath write queue. Concurrent `put()` calls that target the same
   * `(namespace, type, name)` chain their read-modify-write blocks through
   * a promise tail so the _index.json mutation is serialized.
   */
  private writeLocks = new Map<string, Promise<void>>();

  constructor(private opts: LocalStorageProviderOpts) {}

  /**
   * Canonical `file://` URI for the storage root. Surfaced as the
   * `StorageProvider.rootUri` duck-typed property that `pangolin-client`'s
   * dispatch path reads when populating the worker's `PANGOLIN_STORAGE_URI`
   * env var (§6.1). `pathToFileURL` handles Windows drive letters / UNC
   * normalization correctly so the resulting URI round-trips through
   * Node's `fileURLToPath` on the worker side.
   */
  get rootUri(): string {
    return pathToFileURL(this.opts.rootDir).href;
  }

  async put(
    uri: string,
    contents: Uint8Array,
  ): Promise<{ contentHash: string }> {
    const parsed = this.parseSafe(uri);
    if (parsed.kind === 'dispatch-record') {
      return this.putDispatchRecord(parsed, contents);
    }
    return this.putBlob(parsed, contents);
  }

  async get(uri: string): Promise<Uint8Array> {
    const parsed = this.parseSafe(uri);
    if (parsed.kind === 'dispatch-record') {
      return this.getDispatchRecord(parsed, uri);
    }
    return this.getBlob(parsed, uri);
  }

  async resolveLatest(
    uri: string,
  ): Promise<
    { uri: string; contentHash: string; registeredAt: string } | null
  > {
    const parsed = this.parseSafe(uri);
    if (parsed.kind === 'dispatch-record') {
      throw new Error(
        `LocalStorageProvider.resolveLatest is not supported for dispatch-record URIs: ${uri}`,
      );
    }
    const index = await this.readIndex(this.indexPath(parsed));
    if (index.entries.length === 0) return null;
    let latest = index.entries[0]!;
    for (const e of index.entries) {
      if (e.registeredAt > latest.registeredAt) latest = e;
    }
    return {
      uri: buildPangolinUri({
        namespace: parsed.namespace,
        type: parsed.type,
        name: parsed.name,
        contentHash: latest.contentHash,
      }),
      contentHash: latest.contentHash,
      registeredAt: latest.registeredAt,
    };
  }

  async resolveByHash(
    query: { namespace: string; type: string; contentHash: string },
  ): Promise<{
    uri: string;
    name: string;
    contentHash: string;
    registeredAt: string;
  } | null> {
    this.assertSafeSegment(query.namespace, 'namespace');
    this.assertSafeSegment(query.type, 'type');
    this.assertSafeSegment(query.contentHash, 'contentHash');

    const typeDir = join(this.opts.rootDir, query.namespace, query.type);
    let names: string[];
    try {
      const entries = await readdir(typeDir, { withFileTypes: true });
      names = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return null;
      }
      throw err;
    }

    for (const name of names) {
      const index = await this.readIndex(
        join(typeDir, name, '_index.json'),
      );
      const entry = index.entries.find((e) => e.contentHash === query.contentHash);
      if (entry) {
        return {
          uri: buildPangolinUri({
            namespace: query.namespace,
            type: query.type,
            name,
            contentHash: entry.contentHash,
          }),
          name,
          contentHash: entry.contentHash,
          registeredAt: entry.registeredAt,
        };
      }
    }
    return null;
  }

  async list(
    uri: string,
  ): Promise<
    Array<{ uri: string; contentHash: string; registeredAt: string }>
  > {
    const parsed = this.parseSafe(uri);
    if (parsed.kind === 'dispatch-record') {
      throw new Error(
        `LocalStorageProvider.list is not supported for dispatch-record URIs: ${uri}`,
      );
    }
    const index = await this.readIndex(this.indexPath(parsed));
    const sorted = [...index.entries].sort((a, b) =>
      a.registeredAt < b.registeredAt
        ? 1
        : a.registeredAt > b.registeredAt
          ? -1
          : 0,
    );
    return sorted.map((e) => ({
      uri: buildPangolinUri({
        namespace: parsed.namespace,
        type: parsed.type,
        name: parsed.name,
        contentHash: e.contentHash,
      }),
      contentHash: e.contentHash,
      registeredAt: e.registeredAt,
    }));
  }

  // ── Blob (content-addressed) path ──────────────────────────────────────

  private async putBlob(
    parsed: PangolinUriParts,
    contents: Uint8Array,
  ): Promise<{ contentHash: string }> {
    const contentHash = computeContentHash(contents);
    if (parsed.contentHash && parsed.contentHash !== contentHash) {
      throw new IntegrityMismatchError(parsed.contentHash, contentHash);
    }

    const blobPath = this.blobPath(parsed, contentHash);
    await mkdir(dirname(blobPath), { recursive: true });
    await writeFile(blobPath, contents);

    const indexPath = this.indexPath(parsed);
    await this.withIndexLock(indexPath, async () => {
      const index = await this.readIndex(indexPath);
      if (!index.entries.some((e) => e.contentHash === contentHash)) {
        index.entries.push({
          contentHash,
          registeredAt: new Date().toISOString(),
        });
        await writeFile(indexPath, JSON.stringify(index, null, 2));
      }
    });

    return { contentHash };
  }

  private async getBlob(
    parsed: PangolinUriParts,
    uri: string,
  ): Promise<Uint8Array> {
    if (!parsed.contentHash) {
      throw new Error(
        `LocalStorageProvider.get requires a pinned URI with contentHash: ${uri}`,
      );
    }
    const blobPath = this.blobPath(parsed, parsed.contentHash);
    let bytes: Buffer;
    try {
      bytes = await readFile(blobPath);
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        throw new Error(
          `LocalStorageProvider: blob not found for URI: ${uri}`,
        );
      }
      throw err;
    }
    const actual = computeContentHash(bytes);
    if (actual !== parsed.contentHash) {
      throw new IntegrityMismatchError(parsed.contentHash, actual);
    }
    // Return a plain Uint8Array view (readFile returns a Buffer, which is a
    // Uint8Array subclass — surface the narrower type for the contract).
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  // ── Dispatch-record (URI-addressed) path ───────────────────────────────

  private async putDispatchRecord(
    parsed: Extract<StorageUriParts, { kind: 'dispatch-record' }>,
    contents: Uint8Array,
  ): Promise<{ contentHash: string }> {
    const recordPath = this.dispatchRecordPath(parsed);
    await mkdir(dirname(recordPath), { recursive: true });
    // Dispatch records are not content-addressed — writing twice to the same
    // URI overwrites. Compute the hash anyway for the return value so the
    // StorageProvider contract is satisfied with a sane value.
    await writeFile(recordPath, contents);
    return { contentHash: computeContentHash(contents) };
  }

  private async getDispatchRecord(
    parsed: Extract<StorageUriParts, { kind: 'dispatch-record' }>,
    uri: string,
  ): Promise<Uint8Array> {
    const recordPath = this.dispatchRecordPath(parsed);
    let bytes: Buffer;
    try {
      bytes = await readFile(recordPath);
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        throw new Error(
          `LocalStorageProvider: dispatch record not found for URI: ${uri}`,
        );
      }
      throw err;
    }
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  // ── Parsing + path helpers ─────────────────────────────────────────────

  /**
   * Parse the URI through pangolin-core (permissive variant) and then defend
   * against path-traversal segments. The upstream parser rejects empty /
   * slash-containing segments on namespace/type/name but accepts "." and
   * "..", either of which would let a caller escape rootDir when joined
   * into a filesystem path. For dispatch records we additionally check each
   * suffix segment.
   */
  private parseSafe(uri: string): StorageUriParts {
    const parsed = parseStorageUri(uri);
    if (parsed.kind === 'blob') {
      this.assertSafeSegment(parsed.namespace, 'namespace');
      this.assertSafeSegment(parsed.type, 'type');
      this.assertSafeSegment(parsed.name, 'name');
      if (parsed.contentHash !== undefined) {
        this.assertSafeSegment(parsed.contentHash, 'contentHash');
      }
      return parsed;
    }
    // dispatch-record
    this.assertSafeSegment(parsed.namespace, 'namespace');
    this.assertSafeSegment(parsed.dispatchId, 'dispatchId');
    if (parsed.suffix !== undefined) {
      for (const seg of parsed.suffix.split('/')) {
        this.assertSafeSegment(seg, 'suffix segment');
      }
    }
    return parsed;
  }

  private assertSafeSegment(segment: string, label: string): void {
    if (segment === '.' || segment === '..' || segment.includes('..')) {
      throw new Error(
        `LocalStorageProvider: unsafe ${label} segment: "${segment}"`,
      );
    }
  }

  /**
   * Serialize all `fn` calls that share the same `indexPath`. Each call
   * appends its work to a per-path promise tail; release flips the tail
   * forward only when `fn` settles.
   */
  private async withIndexLock<T>(
    indexPath: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.writeLocks.get(indexPath) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    this.writeLocks.set(
      indexPath,
      prev.then(() => next),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private blobPath(parts: PangolinUriParts, contentHash: string): string {
    // Content hashes are of the form `sha256:<hex>` — the ":" is not a legal
    // filename character on Windows, so encode it.
    const safeHash = contentHash.replace(':', '_');
    return join(
      this.opts.rootDir,
      parts.namespace,
      parts.type,
      parts.name,
      `${safeHash}.blob`,
    );
  }

  private indexPath(parts: PangolinUriParts): string {
    return join(
      this.opts.rootDir,
      parts.namespace,
      parts.type,
      parts.name,
      '_index.json',
    );
  }

  /**
   * On-disk path for a dispatch-record URI. The suffix may itself contain
   * `/`; we translate to the platform-native path separator so nested
   * suffixes land in the right subdirectory.
   */
  private dispatchRecordPath(
    parts: Extract<StorageUriParts, { kind: 'dispatch-record' }>,
  ): string {
    const tail = parts.suffix
      ? parts.suffix.split('/').join(sep)
      : '';
    return join(
      this.opts.rootDir,
      parts.namespace,
      'dispatches',
      parts.dispatchId,
      tail,
    );
  }

  private async readIndex(indexPath: string): Promise<IndexFile> {
    try {
      const raw = await readFile(indexPath, 'utf8');
      const parsed = JSON.parse(raw) as IndexFile;
      if (!parsed || !Array.isArray(parsed.entries)) return emptyIndex();
      return parsed;
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return emptyIndex();
      }
      throw err;
    }
  }
}
