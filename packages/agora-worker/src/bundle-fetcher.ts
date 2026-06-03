// agora-worker: bundle fetcher
//
// Fetches the subagent / capability / env bundles advertised in
// AGORA_BUNDLE_REFS_JSON from a StorageProvider and verifies each against
// its declared content hash. Hash mismatch -> IntegrityMismatchError.
//
// Implements §6.2 steps 1-2 and §7.2 of the agora-core spec: the worker
// rejects any tampered bundle before the dispatch proceeds and fails
// fast with `reason: 'integrity-failed'`.

import {
  IntegrityMismatchError,
  computeContentHash,
  verifyContentHash,
  type StorageProvider,
} from "@quarry-systems/agora-core";

import type { BundleRefs } from "./env-parser.js";

export interface FetchedCapability {
  name: string;
  bytes: Uint8Array;
  contentHash: string;
}

export interface FetchedEnv {
  name: string;
  def: Record<string, unknown>;
  contentHash: string;
}

export interface FetchedBundles {
  subagentDef: Record<string, unknown>;
  capabilities: FetchedCapability[];
  envs: FetchedEnv[];
}

/**
 * Construct the appropriate StorageProvider for the given AGORA_STORAGE_URI.
 *
 *   - `s3://<bucket>[/<prefix>]` -> {@link S3StorageProvider}
 *   - `file://<path>`            -> {@link LocalStorageProvider}
 *   - bare absolute path         -> {@link LocalStorageProvider}
 *
 * Throws for any other scheme; the storage URI is a deployment-time choice
 * and silent fallbacks would mask misconfiguration.
 *
 * The S3 / local imports are dynamic so this module stays usable in
 * environments that only need one of the two providers.
 */
export async function constructStorageProvider(
  storageUri: string,
): Promise<StorageProvider> {
  if (storageUri.startsWith("s3://")) {
    let S3StorageProvider: typeof import("@quarry-systems/agora-storage-s3").S3StorageProvider;
    try {
      ({ S3StorageProvider } = await import(
        "@quarry-systems/agora-storage-s3"
      ));
    } catch (err) {
      throw new Error(
        `agora-worker: failed to load S3StorageProvider: ${(err as Error).message}`,
      );
    }
    const withoutScheme = storageUri.slice("s3://".length);
    const slashIdx = withoutScheme.indexOf("/");
    const bucket =
      slashIdx === -1 ? withoutScheme : withoutScheme.slice(0, slashIdx);
    const prefix =
      slashIdx === -1 ? undefined : withoutScheme.slice(slashIdx + 1);
    if (!bucket) {
      throw new Error(
        `s3:// URI requires a non-empty bucket: ${storageUri}`,
      );
    }
    const endpoint = process.env.AGORA_S3_ENDPOINT;
    return new S3StorageProvider(
      endpoint
        ? { bucket, prefix, endpoint, forcePathStyle: true, region: process.env.AWS_REGION ?? 'us-east-1' }
        : { bucket, prefix },
    );
  }
  if (storageUri.startsWith("file://") || storageUri.startsWith("/")) {
    let LocalStorageProvider: typeof import("@quarry-systems/agora-storage-local").LocalStorageProvider;
    try {
      ({ LocalStorageProvider } = await import(
        "@quarry-systems/agora-storage-local"
      ));
    } catch (err) {
      throw new Error(
        `agora-worker: failed to load LocalStorageProvider: ${(err as Error).message}`,
      );
    }
    const rootDir = storageUri.startsWith("file://")
      ? storageUri.slice("file://".length)
      : storageUri;
    return new LocalStorageProvider({ rootDir });
  }
  throw new Error(
    `agora-worker: unrecognized AGORA_STORAGE_URI scheme: ${storageUri}`,
  );
}

/**
 * Fetch every bundle referenced by `refs` from `storage` and verify each
 * against its advertised content hash.
 *
 *   - Subagent: raw bytes are decoded as UTF-8 JSON; the parsed value is
 *     hashed via canonical JSON and compared to `refs.subagent.contentHash`.
 *   - Capabilities: the raw packed bytes themselves are hashed and compared
 *     (capability bundles are opaque tarballs, not JSON, so canonicalization
 *     would be wrong here).
 *   - Envs: raw bytes are decoded as UTF-8 JSON; parsed value is hashed via
 *     canonical JSON and compared.
 *
 * Throws {@link IntegrityMismatchError} on the first mismatch; the worker
 * is expected to translate that into `reason: 'integrity-failed'`.
 */
export async function fetchBundles(
  refs: BundleRefs,
  storage: StorageProvider,
): Promise<FetchedBundles> {
  // 1. Subagent.
  const subagentBytes = await storage.get(refs.subagent.uri);
  const subagentDef = JSON.parse(
    new TextDecoder().decode(subagentBytes),
  ) as Record<string, unknown>;
  verifyContentHash(subagentDef, refs.subagent.contentHash);

  // 2. Capabilities, in declared order. Capability blobs are opaque packed
  //    bytes (tarballs etc.), so we hash the bytes directly rather than
  //    canonicalize.
  const capabilities: FetchedCapability[] = [];
  for (const cap of refs.capabilities) {
    const bytes = await storage.get(cap.uri);
    const actualHash = computeContentHash(bytes);
    if (actualHash !== cap.contentHash) {
      throw new IntegrityMismatchError(cap.contentHash, actualHash);
    }
    capabilities.push({
      name: deriveNameFromUri(cap.uri),
      bytes,
      contentHash: cap.contentHash,
    });
  }

  // 3. Envs.
  const envs: FetchedEnv[] = [];
  for (const env of refs.env) {
    const bytes = await storage.get(env.uri);
    const def = JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
    verifyContentHash(def, env.contentHash);
    envs.push({
      name: deriveNameFromUri(env.uri),
      def,
      contentHash: env.contentHash,
    });
  }

  return { subagentDef, capabilities, envs };
}

/**
 * Extract the `<name>` segment from an agora:// URI.
 *
 * Shape: `agora://<namespace>/<type>/<name>/<contentHash>`.
 * Returns an empty string when the URI is too short to contain a name —
 * callers that need stricter validation should use `parseAgoraUri` directly.
 */
function deriveNameFromUri(uri: string): string {
  const parts = uri.replace(/^agora:\/\//, "").split("/");
  return parts[2] ?? "";
}
