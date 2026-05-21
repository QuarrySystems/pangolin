// @quarry-systems/agora-storage-s3
//
// `S3StorageProvider` implements the `StorageProvider` contract against
// AWS S3 (or any S3-compatible endpoint — LocalStack, MinIO, etc.). The
// on-bucket layout mirrors the agora URI:
//
//   agora://<namespace>/<type>/<name>/<contentHash>
//     -> s3://<bucket>/<prefix?>/<namespace>/<type>/<name>/<contentHash>.blob
//
// Per-(namespace, type, name) registry of registered blobs lives at
//   s3://<bucket>/<prefix?>/<namespace>/<type>/<name>/_index.json
// and is the source of truth for `resolveLatest` / `list`.
//
// Per §5.3 of the agora-core spec, blob writes use S3 conditional writes
// (`If-None-Match: *`) so two concurrent puts of the same content hash
// converge on a single object — a 412 PreconditionFailed response is
// treated as success because the blob already exists.
//
// The reserved type `dispatches` (§7.8) is rejected at the URI-parsing
// layer in agora-core; this implementation needs no additional check.

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  NoSuchKey,
} from '@aws-sdk/client-s3';

import {
  parseAgoraUri,
  buildAgoraUri,
  computeContentHash,
  IntegrityMismatchError,
  type StorageProvider,
  type AgoraUriParts,
} from '@quarry-systems/agora-core';

export interface S3StorageProviderOpts {
  /** Target bucket. The caller is responsible for creating it. */
  bucket: string;
  /** Optional pre-built S3 client (for endpoint overrides, custom creds). */
  client?: S3Client;
  /** Optional prefix inside the bucket. Trailing slashes are normalized. */
  prefix?: string;
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

/** True if the SDK error indicates "no such key / object missing". */
function isNotFound(err: unknown): boolean {
  if (err instanceof NoSuchKey) return true;
  if (err && typeof err === 'object') {
    const name = (err as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return true;
    const status = (err as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    if (status === 404) return true;
  }
  return false;
}

/** True if the SDK error indicates a precondition failure (412). */
function isPreconditionFailed(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const status = (err as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    if (status === 412) return true;
    const name = (err as { name?: string }).name;
    if (name === 'PreconditionFailed') return true;
  }
  return false;
}

async function streamToUint8Array(body: unknown): Promise<Uint8Array> {
  // AWS SDK v3 surfaces the body as a sdk-stream-mixin with helpers, but to
  // stay portable across Node / browser builds we feature-detect.
  if (body == null) return new Uint8Array(0);
  const maybe = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  } & AsyncIterable<Uint8Array>;
  if (typeof maybe.transformToByteArray === 'function') {
    return await maybe.transformToByteArray();
  }
  if (typeof maybe.arrayBuffer === 'function') {
    return new Uint8Array(await maybe.arrayBuffer());
  }
  // Fallback: async iterator of chunks.
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of maybe) {
    const c = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    chunks.push(c);
    total += c.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export class S3StorageProvider implements StorageProvider {
  readonly name = 's3';
  private readonly s3: S3Client;
  private readonly prefix: string;

  constructor(private opts: S3StorageProviderOpts) {
    this.s3 = opts.client ?? new S3Client({});
    // Normalize prefix to "" or "foo/" form.
    const raw = (opts.prefix ?? '').replace(/^\/+|\/+$/g, '');
    this.prefix = raw.length === 0 ? '' : `${raw}/`;
  }

  async put(
    uri: string,
    contents: Uint8Array,
  ): Promise<{ contentHash: string }> {
    const parsed = parseAgoraUri(uri);
    const contentHash = computeContentHash(contents);
    if (parsed.contentHash && parsed.contentHash !== contentHash) {
      throw new IntegrityMismatchError(parsed.contentHash, contentHash);
    }

    const blobKey = this.blobKey(parsed, contentHash);
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.opts.bucket,
          Key: blobKey,
          Body: contents,
          // Idempotent dedup: if the object already exists with this hash,
          // S3 returns 412 PreconditionFailed — that's the success path
          // because the content is content-addressed.
          IfNoneMatch: '*',
        }),
      );
    } catch (err) {
      if (!isPreconditionFailed(err)) throw err;
    }

    await this.updateIndex(parsed, contentHash);
    return { contentHash };
  }

  async get(uri: string): Promise<Uint8Array> {
    const parsed = parseAgoraUri(uri);
    if (!parsed.contentHash) {
      throw new Error(
        `S3StorageProvider.get requires a pinned URI with contentHash: ${uri}`,
      );
    }
    const blobKey = this.blobKey(parsed, parsed.contentHash);
    const resp = await this.s3.send(
      new GetObjectCommand({ Bucket: this.opts.bucket, Key: blobKey }),
    );
    const bytes = await streamToUint8Array(resp.Body);
    const actual = computeContentHash(bytes);
    if (actual !== parsed.contentHash) {
      throw new IntegrityMismatchError(parsed.contentHash, actual);
    }
    return bytes;
  }

  async resolveLatest(
    uri: string,
  ): Promise<
    { uri: string; contentHash: string; registeredAt: string } | null
  > {
    const parsed = parseAgoraUri(uri);
    const index = await this.readIndex(parsed);
    if (index.entries.length === 0) return null;
    let latest = index.entries[0]!;
    for (const e of index.entries) {
      if (e.registeredAt > latest.registeredAt) latest = e;
    }
    return {
      uri: buildAgoraUri({
        namespace: parsed.namespace,
        type: parsed.type,
        name: parsed.name,
        contentHash: latest.contentHash,
      }),
      contentHash: latest.contentHash,
      registeredAt: latest.registeredAt,
    };
  }

  async list(
    uri: string,
  ): Promise<
    Array<{ uri: string; contentHash: string; registeredAt: string }>
  > {
    const parsed = parseAgoraUri(uri);
    const index = await this.readIndex(parsed);
    const sorted = [...index.entries].sort((a, b) =>
      a.registeredAt < b.registeredAt
        ? 1
        : a.registeredAt > b.registeredAt
          ? -1
          : 0,
    );
    return sorted.map((e) => ({
      uri: buildAgoraUri({
        namespace: parsed.namespace,
        type: parsed.type,
        name: parsed.name,
        contentHash: e.contentHash,
      }),
      contentHash: e.contentHash,
      registeredAt: e.registeredAt,
    }));
  }

  private keyFor(
    namespace: string,
    type: string,
    name: string,
    leaf: string,
  ): string {
    return `${this.prefix}${namespace}/${type}/${name}/${leaf}`;
  }

  private blobKey(parts: AgoraUriParts, contentHash: string): string {
    // Content hashes are of the form `sha256:<hex>`. ":" is legal in S3
    // keys, but we still encode for parity with the local provider and
    // to keep keys friendly to common tooling.
    const safeHash = contentHash.replace(':', '_');
    return this.keyFor(parts.namespace, parts.type, parts.name, `${safeHash}.blob`);
  }

  private indexKey(parts: AgoraUriParts): string {
    return this.keyFor(parts.namespace, parts.type, parts.name, '_index.json');
  }

  private async readIndex(parts: AgoraUriParts): Promise<IndexFile> {
    try {
      const resp = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.opts.bucket,
          Key: this.indexKey(parts),
        }),
      );
      const bytes = await streamToUint8Array(resp.Body);
      const text = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(text) as IndexFile;
      if (!parsed || !Array.isArray(parsed.entries)) return emptyIndex();
      return parsed;
    } catch (err) {
      if (isNotFound(err)) return emptyIndex();
      throw err;
    }
  }

  private async updateIndex(
    parts: AgoraUriParts,
    contentHash: string,
  ): Promise<void> {
    const index = await this.readIndex(parts);
    if (index.entries.some((e) => e.contentHash === contentHash)) {
      // Already registered — content-addressed dedup. Nothing to do.
      return;
    }
    index.entries.push({
      contentHash,
      registeredAt: new Date().toISOString(),
    });
    const body = new TextEncoder().encode(JSON.stringify(index, null, 2));
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: this.indexKey(parts),
        Body: body,
        ContentType: 'application/json',
      }),
    );
  }
}
