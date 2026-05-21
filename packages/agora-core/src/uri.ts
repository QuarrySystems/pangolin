// agora:// URI parser and builder.
//
// Shape:
//   agora://<namespace>/<type>/<name>/<contentHash>   (blob address — pinned)
//   agora://<namespace>/<type>/<name>                  (resolve/list address)
//
// `dispatches` is a reserved type and must never appear in an agora:// URI
// per §7.8 of the agora-core spec — dispatch identity is event-stream
// derived, not URI-addressable.

/** Parsed components of an agora:// URI. */
export interface AgoraUriParts {
  namespace: string;
  type: string;
  name: string;
  /** Present iff the URI is a pinned blob address. */
  contentHash?: string;
}

const SCHEME = 'agora://';
const RESERVED_TYPES = new Set(['dispatches']);

function assertSegment(segment: string, label: string): void {
  if (segment.length === 0) {
    throw new Error(`agora URI: empty ${label} segment`);
  }
  if (segment.includes('/')) {
    // Defense in depth — split('/') already prevents this — but make the
    // contract explicit for callers that construct via buildAgoraUri.
    throw new Error(`agora URI: ${label} segment must not contain "/"`);
  }
}

function assertTypeNotReserved(type: string): void {
  if (RESERVED_TYPES.has(type)) {
    throw new Error(`agora URI: type "${type}" is reserved`);
  }
}

/**
 * Parse an agora:// URI into its components.
 *
 * @throws Error if the URI is malformed or uses a reserved type.
 */
export function parseAgoraUri(uri: string): AgoraUriParts {
  if (typeof uri !== 'string' || !uri.startsWith(SCHEME)) {
    throw new Error(`agora URI: must start with "${SCHEME}", got: ${uri}`);
  }
  const rest = uri.slice(SCHEME.length);
  const segments = rest.split('/');

  if (segments.length < 3 || segments.length > 4) {
    throw new Error(
      `agora URI: expected 3 or 4 segments after scheme, got ${segments.length}: ${uri}`,
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
 * Build an agora:// URI from its components. Validates the same
 * invariants as {@link parseAgoraUri}, so a parse → build round-trip
 * is the identity on well-formed inputs.
 */
export function buildAgoraUri(parts: AgoraUriParts): string {
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
