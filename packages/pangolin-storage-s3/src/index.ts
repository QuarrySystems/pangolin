// @quarry-systems/pangolin-storage-s3
//
// `S3StorageProvider` implements the `StorageProvider` contract against
// AWS S3 (or any S3-compatible endpoint — LocalStack, MinIO, etc.). The
// on-bucket layout mirrors the pangolin URI:
//
//   pangolin://<namespace>/<type>/<name>/<contentHash>
//     -> s3://<bucket>/<prefix?>/<namespace>/<type>/<name>/<contentHash>.blob
//
// Per-(namespace, type, name) registry of registered blobs lives at
//   s3://<bucket>/<prefix?>/<namespace>/<type>/<name>/_index.json
// and is the source of truth for `resolveLatest` / `list`.
//
// Per §5.3 of the pangolin-core spec, blob writes use S3 conditional writes
// (`If-None-Match: *`) so two concurrent puts of the same content hash
// converge on a single object — a 412 PreconditionFailed response is
// treated as success because the blob already exists.
//
// Dispatch records (URIs under the reserved `dispatches/` prefix, per §7.8
// and `buildDispatchRecordUri`) take a separate code path: they are NOT
// content-addressed, so each URI maps directly to a single S3 object with
// no `_index.json` and no hash-suffixed `.blob` key:
//
//   pangolin://<namespace>/dispatches/<dispatchId>[/<suffix>]
//     -> s3://<bucket>/<prefix?>/<namespace>/dispatches/<dispatchId>[/<suffix>]
//
// `parseStorageUri` from pangolin-core is the permissive parser that accepts
// both shapes. The general `parsePangolinUri` still rejects `dispatches` as a
// client-side write-safety guard.

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';

import {
  parseStorageUri,
  buildPangolinUri,
  computeContentHash,
  ConflictError,
  IntegrityMismatchError,
  type StorageProvider,
  type PangolinUriParts,
  type StorageUriParts,
} from '@quarry-systems/pangolin-core';

export interface S3StorageProviderOpts {
  /** Target bucket. The caller is responsible for creating it. */
  bucket: string;
  /** Optional pre-built S3 client (for endpoint overrides, custom creds).
   *  When supplied it takes precedence over `endpoint`/`forcePathStyle`/`region`. */
  client?: S3Client;
  /** Optional prefix inside the bucket. Trailing slashes are normalized. */
  prefix?: string;
  /** Custom endpoint URL — e.g. `http://localhost:9000` for MinIO or LocalStack.
   *  When set (and no `client` is supplied) a new S3Client is built targeting
   *  this endpoint. Credentials are resolved from the SDK's default env chain. */
  endpoint?: string;
  /** Enable S3 path-style addressing (`/<bucket>/<key>`).
   *  Required by MinIO; ignored when `client` is supplied. */
  forcePathStyle?: boolean;
  /** AWS region for the auto-built client. Defaults to `'us-east-1'`.
   *  Ignored when `client` is supplied. */
  region?: string;
  /** Server-side encryption applied to every object Pangolin Scale writes.
   *  Omit to inherit the bucket's default encryption (SSE-S3 has been on by
   *  default for all S3 buckets since Jan 2023). Set to enforce an explicit
   *  mode — e.g. customer-managed KMS (BYOK). */
  encryption?:
    | { mode: 'AES256' }
    | { mode: 'aws:kms'; kmsKeyId?: string };
}

/** Subset of PutObject SSE fields derived from {@link S3StorageProviderOpts.encryption}. */
interface SseParams {
  ServerSideEncryption?: ServerSideEncryption;
  SSEKMSKeyId?: string;
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

/**
 * Translate the public {@link S3StorageProviderOpts.encryption} option into
 * the PutObject SSE fields. Returns an empty object when encryption is
 * omitted so callers spread nothing (the no-downgrade rule).
 */
function deriveSseParams(
  encryption: S3StorageProviderOpts['encryption'],
): SseParams {
  if (!encryption) return {};
  if (encryption.mode === 'AES256') {
    return { ServerSideEncryption: 'AES256' };
  }
  return {
    ServerSideEncryption: 'aws:kms',
    ...(encryption.kmsKeyId ? { SSEKMSKeyId: encryption.kmsKeyId } : {}),
  };
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

export { AwsS3MailboxClient } from './aws-s3-mailbox-client.js';
export type { AwsS3MailboxClientOpts } from './aws-s3-mailbox-client.js';
export { AwsS3LockClient } from './aws-s3-lock-client.js';
export type { AwsS3LockClientOpts } from './aws-s3-lock-client.js';

export class S3StorageProvider implements StorageProvider {
  readonly name = 's3';
  private readonly s3: S3Client;
  private readonly prefix: string;
  /**
   * SSE fields spread into every PutObjectCommand input. Empty when
   * `encryption` is omitted — the no-downgrade rule: forcing AES256 onto a
   * bucket whose default is KMS would silently downgrade it, so we touch no
   * SSE field at all and let the bucket default apply.
   */
  private readonly sseParams: SseParams;

  constructor(private opts: S3StorageProviderOpts) {
    this.s3 = opts.client ?? new S3Client(
      opts.endpoint
        ? { endpoint: opts.endpoint, forcePathStyle: opts.forcePathStyle, region: opts.region ?? 'us-east-1' }
        : {},
    );
    // Normalize prefix to "" or "foo/" form.
    const raw = (opts.prefix ?? '').replace(/^\/+|\/+$/g, '');
    this.prefix = raw.length === 0 ? '' : `${raw}/`;
    this.sseParams = deriveSseParams(opts.encryption);
  }

  /**
   * Canonical `s3://` URI for the storage root. Surfaced as the
   * `StorageProvider.rootUri` duck-typed property that `pangolin-client`'s
   * dispatch path reads when populating the worker's `PANGOLIN_STORAGE_URI`
   * env var (§6.1). The worker's bundle-fetcher recognizes both
   * `s3://<bucket>` and `s3://<bucket>/<prefix>` forms and routes to
   * `S3StorageProvider`.
   */
  get rootUri(): string {
    // `this.prefix` already has a trailing slash (or is empty); strip it so
    // the canonical URI does not end on `/`.
    const trimmed = this.prefix.endsWith('/')
      ? this.prefix.slice(0, -1)
      : this.prefix;
    return trimmed.length === 0
      ? `s3://${this.opts.bucket}`
      : `s3://${this.opts.bucket}/${trimmed}`;
  }

  async put(
    uri: string,
    contents: Uint8Array,
  ): Promise<{ contentHash: string }> {
    const parsed = parseStorageUri(uri);
    if (parsed.kind === 'dispatch-record') {
      return this.putDispatchRecord(parsed, contents);
    }
    return this.putBlob(parsed, contents);
  }

  async get(uri: string): Promise<Uint8Array> {
    const parsed = parseStorageUri(uri);
    if (parsed.kind === 'dispatch-record') {
      return this.getDispatchRecord(parsed);
    }
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
    const parsed = parseStorageUri(uri);
    if (parsed.kind === 'dispatch-record') {
      throw new Error(
        `S3StorageProvider.resolveLatest is not supported for dispatch-record URIs: ${uri}`,
      );
    }
    const index = await this.readIndex(parsed);
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
    // Enumerate logical names under `<prefix><ns>/<type>/` via ListObjectsV2
    // with `Delimiter: '/'` — the per-name subdirectories surface as
    // `CommonPrefixes`. For each candidate name read its `_index.json` and
    // check for a matching contentHash. O(names) GET requests; acceptable
    // for v0.1, a sidecar hash→name index lands in v0.2 if registries grow.
    const namePrefix = `${this.prefix}${query.namespace}/${query.type}/`;
    let continuationToken: string | undefined;
    const names: string[] = [];
    do {
      const resp = (await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.opts.bucket,
          Prefix: namePrefix,
          Delimiter: '/',
          ContinuationToken: continuationToken,
        }),
      )) as {
        CommonPrefixes?: Array<{ Prefix?: string }>;
        NextContinuationToken?: string;
        IsTruncated?: boolean;
      };
      for (const cp of resp.CommonPrefixes ?? []) {
        if (!cp.Prefix) continue;
        // CommonPrefixes look like `<namePrefix><name>/` — strip both ends.
        const tail = cp.Prefix.slice(namePrefix.length);
        const name = tail.endsWith('/') ? tail.slice(0, -1) : tail;
        if (name.length > 0) names.push(name);
      }
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);

    for (const name of names) {
      const index = await this.readIndex({
        kind: 'blob',
        namespace: query.namespace,
        type: query.type,
        name,
      } as PangolinUriParts);
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
    const parsed = parseStorageUri(uri);
    if (parsed.kind === 'dispatch-record') {
      throw new Error(
        `S3StorageProvider.list is not supported for dispatch-record URIs: ${uri}`,
      );
    }
    const index = await this.readIndex(parsed);
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

    const blobKey = this.blobKey(parsed, contentHash);
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.opts.bucket,
          Key: blobKey,
          Body: contents,
          ...this.sseParams,
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

  // ── Dispatch-record (URI-addressed) path ───────────────────────────────

  private async putDispatchRecord(
    parsed: Extract<StorageUriParts, { kind: 'dispatch-record' }>,
    contents: Uint8Array,
  ): Promise<{ contentHash: string }> {
    const key = this.dispatchRecordKey(parsed);
    // Dispatch records are NOT content-addressed — overwrites are intentional
    // (re-sealing the same dispatchId replaces the prior record). Compute
    // the hash anyway for the return value so the StorageProvider contract
    // is satisfied with a sane value.
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: contents,
        ...this.sseParams,
      }),
    );
    return { contentHash: computeContentHash(contents) };
  }

  private async getDispatchRecord(
    parsed: Extract<StorageUriParts, { kind: 'dispatch-record' }>,
  ): Promise<Uint8Array> {
    const key = this.dispatchRecordKey(parsed);
    const resp = await this.s3.send(
      new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }),
    );
    return await streamToUint8Array(resp.Body);
  }

  private dispatchRecordKey(
    parts: Extract<StorageUriParts, { kind: 'dispatch-record' }>,
  ): string {
    const tail = parts.suffix ? `/${parts.suffix}` : '';
    return `${this.prefix}${parts.namespace}/dispatches/${parts.dispatchId}${tail}`;
  }

  private keyFor(
    namespace: string,
    type: string,
    name: string,
    leaf: string,
  ): string {
    return `${this.prefix}${namespace}/${type}/${name}/${leaf}`;
  }

  private blobKey(parts: PangolinUriParts, contentHash: string): string {
    // Content hashes are of the form `sha256:<hex>`. ":" is legal in S3
    // keys, but we still encode for parity with the local provider and
    // to keep keys friendly to common tooling.
    const safeHash = contentHash.replace(':', '_');
    return this.keyFor(parts.namespace, parts.type, parts.name, `${safeHash}.blob`);
  }

  private indexKey(parts: PangolinUriParts): string {
    return this.keyFor(parts.namespace, parts.type, parts.name, '_index.json');
  }

  private async readIndex(parts: PangolinUriParts): Promise<IndexFile> {
    const { index } = await this.readIndexWithEtag(parts);
    return index;
  }

  /**
   * Read the index alongside its ETag. The ETag is required by
   * `updateIndex` to drive S3 conditional-write optimistic concurrency:
   * subsequent index puts pass `IfMatch: <etag>` so two concurrent
   * `put()` calls on the same (namespace, type, name) cannot silently
   * stomp each other.
   *
   * When the index does not yet exist, `etag` is `undefined` and the
   * caller is expected to write with `IfNoneMatch: '*'`.
   */
  private async readIndexWithEtag(
    parts: PangolinUriParts,
  ): Promise<{ index: IndexFile; etag: string | undefined }> {
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
      const etag = (resp as { ETag?: string }).ETag;
      if (!parsed || !Array.isArray(parsed.entries)) {
        return { index: emptyIndex(), etag };
      }
      return { index: parsed, etag };
    } catch (err) {
      if (isNotFound(err)) return { index: emptyIndex(), etag: undefined };
      throw err;
    }
  }

  /**
   * Append `contentHash` to the per-(namespace, type, name) index file
   * using S3 conditional writes so concurrent writers cannot last-writer-
   * wins each other.
   *
   * Loop:
   *   1. GET the index, capturing ETag.
   *   2. If the contentHash is already present, return (dedup).
   *   3. PUT the updated index with `IfMatch: <etag>` (or
   *      `IfNoneMatch: '*'` when creating fresh).
   *   4. On 412 PreconditionFailed, another writer landed first —
   *      retry the whole read-modify-write with exponential backoff.
   *
   * After {@link MAX_INDEX_UPDATE_ATTEMPTS} attempts we surface a
   * {@link ConflictError} rather than corrupting the index.
   *
   * S3 has supported `IfMatch` on PutObject since November 2024. Against
   * older S3-compatible endpoints that don't honor it, the precondition
   * is ignored server-side and we degrade to the prior last-writer-wins
   * behavior — not silently broken, just unguarded. LocalStack honors it
   * and the smoke test covers the happy path.
   */
  private async updateIndex(
    parts: PangolinUriParts,
    contentHash: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_INDEX_UPDATE_ATTEMPTS; attempt++) {
      const { index, etag } = await this.readIndexWithEtag(parts);
      if (index.entries.some((e) => e.contentHash === contentHash)) {
        // Already registered — content-addressed dedup. Nothing to do.
        return;
      }
      index.entries.push({
        contentHash,
        registeredAt: new Date().toISOString(),
      });
      const body = new TextEncoder().encode(JSON.stringify(index, null, 2));
      try {
        await this.s3.send(
          new PutObjectCommand({
            Bucket: this.opts.bucket,
            Key: this.indexKey(parts),
            Body: body,
            ContentType: 'application/json',
            ...this.sseParams,
            ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
          }),
        );
        return;
      } catch (err) {
        if (!isPreconditionFailed(err)) throw err;
        // 412: another writer landed first. Back off and retry the
        // entire read-modify-write loop with the freshly observed etag.
        const delayMs = INDEX_UPDATE_BASE_BACKOFF_MS * (1 << attempt);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw new ConflictError(
      `index update failed after ${MAX_INDEX_UPDATE_ATTEMPTS} retries: ` +
        `${parts.namespace}/${parts.type}/${parts.name}`,
    );
  }
}

/** Max attempts for the optimistic-concurrency index update loop. */
const MAX_INDEX_UPDATE_ATTEMPTS = 5;

/** Base delay for exponential backoff between index-update retries. */
const INDEX_UPDATE_BASE_BACKOFF_MS = 50;
