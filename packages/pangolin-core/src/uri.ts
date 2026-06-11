// pangolin:// URI parser and builder.
//
// Shape:
//   pangolin://<namespace>/<type>/<name>/<contentHash>   (blob address — pinned)
//   pangolin://<namespace>/<type>/<name>                  (resolve/list address)
//
// `dispatches` is a reserved type and must never appear in an pangolin:// URI
// per §7.8 of the pangolin-core spec — dispatch identity is event-stream
// derived, not URI-addressable.

/** Parsed components of an pangolin:// URI. */
export interface PangolinUriParts {
  namespace: string;
  type: string;
  name: string;
  /** Present iff the URI is a pinned blob address. */
  contentHash?: string;
}

/**
 * Parsed components of a dispatch-record URI (under the reserved
 * `dispatches/` prefix per §7.8). Distinct from {@link PangolinUriParts}
 * because dispatch records are NOT content-addressed — the URI itself
 * is the canonical address, there is no `contentHash`, and the suffix
 * may itself contain `/` to address nested record components.
 */
export interface DispatchRecordUriParts {
  namespace: string;
  dispatchId: string;
  /**
   * The path under the dispatch root. Absent when the URI addresses the
   * dispatch root itself. May contain `/` for nested addressing
   * (e.g. `"events/0001.json"`).
   */
  suffix?: string;
}

/**
 * Discriminated union returned by {@link parseStorageUri}. Storage
 * providers branch on `kind` to decide between content-addressed blob
 * handling and dispatch-record handling.
 */
export type StorageUriParts =
  | ({ kind: 'blob' } & PangolinUriParts)
  | ({ kind: 'dispatch-record' } & DispatchRecordUriParts);

const SCHEME = 'pangolin://';
const RESERVED_TYPES = new Set(['dispatches']);

function assertSegment(segment: string, label: string): void {
  if (segment.length === 0) {
    throw new Error(`pangolin URI: empty ${label} segment`);
  }
  if (segment.includes('/')) {
    // Defense in depth — split('/') already prevents this — but make the
    // contract explicit for callers that construct via buildPangolinUri.
    throw new Error(`pangolin URI: ${label} segment must not contain "/"`);
  }
}

function assertTypeNotReserved(type: string): void {
  if (RESERVED_TYPES.has(type)) {
    throw new Error(`pangolin URI: type "${type}" is reserved`);
  }
}

/**
 * Parse an pangolin:// URI into its components.
 *
 * @throws Error if the URI is malformed or uses a reserved type.
 */
export function parsePangolinUri(uri: string): PangolinUriParts {
  if (typeof uri !== 'string' || !uri.startsWith(SCHEME)) {
    throw new Error(`pangolin URI: must start with "${SCHEME}", got: ${uri}`);
  }
  const rest = uri.slice(SCHEME.length);
  const segments = rest.split('/');

  if (segments.length < 3 || segments.length > 4) {
    throw new Error(
      `pangolin URI: expected 3 or 4 segments after scheme, got ${segments.length}: ${uri}`,
    );
  }

  const [namespace, type, name, contentHash] = segments;
  assertSegment(namespace, 'namespace');
  assertSegment(type, 'type');
  assertSegment(name, 'name');
  assertTypeNotReserved(type);

  if (contentHash !== undefined) {
    assertSegment(contentHash, 'contentHash');
    return { namespace, type, name, contentHash };
  }
  return { namespace, type, name };
}

/**
 * Build an pangolin:// URI from its components. Validates the same
 * invariants as {@link parsePangolinUri}, so a parse → build round-trip
 * is the identity on well-formed inputs.
 */
export function buildPangolinUri(parts: PangolinUriParts): string {
  assertSegment(parts.namespace, 'namespace');
  assertSegment(parts.type, 'type');
  assertSegment(parts.name, 'name');
  assertTypeNotReserved(parts.type);

  const base = `${SCHEME}${parts.namespace}/${parts.type}/${parts.name}`;
  if (parts.contentHash !== undefined) {
    assertSegment(parts.contentHash, 'contentHash');
    return `${base}/${parts.contentHash}`;
  }
  return base;
}

/**
 * Permissive parser used by storage providers. Accepts BOTH the normal
 * blob shape (3 or 4 segments, non-reserved type) AND the reserved
 * `dispatches/` shape (`pangolin://<ns>/dispatches/<id>[/<suffix>]` with
 * arbitrary `/`-bearing suffix).
 *
 * The general {@link parsePangolinUri} intentionally rejects `type ===
 * 'dispatches'` as a client-side write-safety guard (preventing
 * `buildPangolinUri({type: 'dispatches'})` from accidentally colliding with
 * dispatch records). Storage providers are the layer that legitimately
 * reads and writes dispatch records, and use this permissive parser so
 * that `LocalStorageProvider.put(dispatchUri, bytes)` works without
 * weakening the general-parser guarantee.
 *
 * @throws Error if the URI is malformed (missing scheme, empty segments,
 *   wrong segment count for the inferred shape, or a reserved type other
 *   than `dispatches`).
 */
export function parseStorageUri(uri: string): StorageUriParts {
  if (typeof uri !== 'string' || !uri.startsWith(SCHEME)) {
    throw new Error(`pangolin URI: must start with "${SCHEME}", got: ${uri}`);
  }
  const rest = uri.slice(SCHEME.length);
  const segments = rest.split('/');

  if (segments.length < 3) {
    throw new Error(
      `pangolin URI: expected at least 3 segments after scheme, got ${segments.length}: ${uri}`,
    );
  }

  const [namespace, type] = segments;
  assertSegment(namespace, 'namespace');
  assertSegment(type, 'type');

  if (type === 'dispatches') {
    // Dispatch-record shape: pangolin://<ns>/dispatches/<id>[/<suffix...>]
    const dispatchId = segments[2]!;
    assertSegment(dispatchId, 'dispatchId');
    if (segments.length === 3) {
      return { kind: 'dispatch-record', namespace, dispatchId };
    }
    // Join remaining segments back into a slash-bearing suffix. Each
    // segment must be non-empty so we reject `//` runs in the suffix.
    const suffixSegments = segments.slice(3);
    for (const s of suffixSegments) {
      if (s.length === 0) {
        throw new Error(
          `pangolin URI: empty segment in dispatches suffix: ${uri}`,
        );
      }
    }
    return {
      kind: 'dispatch-record',
      namespace,
      dispatchId,
      suffix: suffixSegments.join('/'),
    };
  }

  // Normal blob shape: pangolin://<ns>/<type>/<name>[/<contentHash>]
  if (segments.length > 4) {
    throw new Error(
      `pangolin URI: expected 3 or 4 segments after scheme for type "${type}", got ${segments.length}: ${uri}`,
    );
  }
  const name = segments[2]!;
  const contentHash = segments[3];
  assertSegment(name, 'name');
  // No reserved-type check here — the WHOLE POINT of parseStorageUri is to
  // accept dispatches (handled above) without weakening the general parser.
  if (contentHash !== undefined) {
    assertSegment(contentHash, 'contentHash');
    return { kind: 'blob', namespace, type, name, contentHash };
  }
  return { kind: 'blob', namespace, type, name };
}

/**
 * Construct a dispatch-record URI under the reserved `dispatches/` prefix
 * documented in §7.8 of the pangolin-core spec. The general {@link buildPangolinUri}
 * rejects `type: 'dispatches'` to prevent capability/subagent/env writes from
 * colliding with this prefix; this helper is the documented escape hatch for
 * the retention layer, which legitimately owns the reserved namespace.
 *
 * Shape:
 *   `pangolin://<namespace>/dispatches/<dispatchId>`            (no suffix)
 *   `pangolin://<namespace>/dispatches/<dispatchId>/<suffix>`   (with suffix)
 *
 * `suffix` may itself contain `/` to address nested record components (e.g.
 * `"events/0001.json"`), but must not be empty or contain `//`.
 *
 * @throws Error if `namespace` or `dispatchId` is empty or contains `/`, or
 *   if `suffix` is the empty string or contains `//`.
 */
export function buildDispatchRecordUri(
  namespace: string,
  dispatchId: string,
  suffix?: string,
): string {
  if (!namespace || namespace.includes('/')) {
    throw new Error(
      `buildDispatchRecordUri: invalid namespace: ${JSON.stringify(namespace)}`,
    );
  }
  if (!dispatchId || dispatchId.includes('/')) {
    throw new Error(
      `buildDispatchRecordUri: invalid dispatchId: ${JSON.stringify(dispatchId)}`,
    );
  }
  if (suffix !== undefined && (suffix === '' || suffix.includes('//'))) {
    throw new Error(
      `buildDispatchRecordUri: invalid suffix: ${JSON.stringify(suffix)}`,
    );
  }
  const tail = suffix ? `/${suffix}` : '';
  return `${SCHEME}${namespace}/dispatches/${dispatchId}${tail}`;
}
