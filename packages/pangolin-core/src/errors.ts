// Named error classes for the pangolin-core surface.
//
// Each error class sets `name` to its class name so callers can use
// `err.name === 'IntegrityMismatchError'` for structural matching, even
// across realms / serialized payloads.

/**
 * Thrown when a value that looks credential-shaped (e.g. an AWS access key,
 * a private key block, or a bearer token) is detected in an environment
 * field that is supposed to hold only non-secret configuration.
 */
export class CredentialsInEnvError extends Error {
  constructor(
    public field: string,
    public detail: string,
  ) {
    super(`credential-shaped value in env field "${field}": ${detail}`);
    this.name = 'CredentialsInEnvError';
  }
}

/**
 * Thrown when a registered capability bundle exceeds the size cap (50 MiB).
 */
export class CapabilityTooLargeError extends Error {
  constructor(public sizeBytes: number) {
    super(`capability bundle is ${sizeBytes} bytes; cap is 50 MiB`);
    this.name = 'CapabilityTooLargeError';
  }
}

/**
 * Thrown when a storage write fails due to an optimistic-concurrency or
 * uniqueness conflict (e.g. a duplicate content-addressed put with a
 * different payload, or a stale mtime on a claim).
 */
export class ConflictError extends Error {
  constructor(public detail: string) {
    super(`storage conflict: ${detail}`);
    this.name = 'ConflictError';
  }
}

/**
 * Thrown when a subagent's `partial_state` serializes to more than 1 MiB.
 */
export class PartialStateTooLargeError extends Error {
  constructor(public sizeBytes: number) {
    super(`partial_state is ${sizeBytes} bytes serialized; cap is 1 MiB`);
    this.name = 'PartialStateTooLargeError';
  }
}

/**
 * Thrown when a container image reference is not pinned to an immutable
 * digest (`image@sha256:...`) but the caller required a pinned image.
 */
export class UnpinnedImageError extends Error {
  constructor(public image: string) {
    super(`image not digest-pinned: ${image}`);
    this.name = 'UnpinnedImageError';
  }
}

/**
 * Thrown when a content-addressed payload's recomputed hash does not match
 * the expected hash advertised by the addressing layer.
 */
export class IntegrityMismatchError extends Error {
  constructor(
    public expected: string,
    public actual: string,
  ) {
    super(`content hash mismatch: expected ${expected}, got ${actual}`);
    this.name = 'IntegrityMismatchError';
  }
}

/**
 * Thrown by a `StorageProvider.get` implementation when the requested
 * object does not exist. `uri` carries the caller-facing `pangolin://` URI
 * (not a backend-specific key). A second constructor argument lets a
 * provider supply its own message while `uri` and `name` stay fixed.
 */
export class StorageNotFoundError extends Error {
  constructor(
    readonly uri: string,
    message = `storage object not found: ${uri}`,
  ) {
    super(message);
    this.name = 'StorageNotFoundError';
  }
}

/**
 * True when `err` signals a missing storage object.
 *
 * The `name` comparison is the load-bearing leg — per this file's header
 * convention it survives realms and duplicate package copies. `instanceof` is
 * exact-match insurance for a single-copy tree and adds no behaviour the name
 * check does not already cover. Not a type predicate: a name comparison cannot
 * soundly narrow to the class.
 */
export function isStorageNotFound(err: unknown): boolean {
  if (err instanceof StorageNotFoundError) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'StorageNotFoundError'
  );
}
