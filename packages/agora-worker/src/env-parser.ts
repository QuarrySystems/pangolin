// agora-worker: env var parser
// Parses + validates AGORA_* env vars per spec §6.1.

export interface BundleRef {
  uri: string;
  contentHash: string;
}

export interface BundleRefs {
  subagent: BundleRef;
  capabilities: BundleRef[];
  env: BundleRef[];
}

export interface WorkerConfig {
  dispatchId: string;
  namespace: string;
  storageUri: string;
  bundleRefs: BundleRefs;
  inputJson: Record<string, unknown>;
  callbackUrl?: string;
  callbackTokenRef?: string;
  /**
   * Per-dispatch secret references (envName → store ref), passed by the
   * client so the WORKER resolves and registers them for redaction rather
   * than relying on ambient compute-layer injection (which left them
   * un-redacted). Empty when the dispatch carried no per-dispatch secrets.
   */
  perDispatchSecretRefs: Record<string, string>;
  /**
   * Directory the `LocalSecretStore` reads per-dispatch secret files from.
   * Set (by the local-docker provider, to the in-container bind-mount target)
   * only when secrets are staged on the local filesystem; unset for the AWS
   * path, where the worker falls back to `AwsSecretStore`.
   */
  secretStoreDir?: string;
  /**
   * Which secret-store adapter the worker should instantiate.
   * Defaults to `"aws-secrets-manager"` when `AGORA_SECRET_STORE_KIND` is
   * absent, preserving the existing AWS behavior.
   */
  secretStoreKind: "aws-secrets-manager" | "local-file";
  runtimeAdapter: string;
  setupTimeoutSeconds: number;
  disableNeedsInputHelper: boolean;
}

function parsePositiveInteger(raw: string, varName: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(
      `agora-worker: ${varName} must be a non-negative integer, got: ${raw}`,
    );
  }
  return n;
}

export function parseWorkerEnv(
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  const required = (k: string): string => {
    const v = env[k];
    if (!v) {
      throw new Error(`agora-worker: required env var ${k} is not set`);
    }
    return v;
  };

  const dispatchId = required("AGORA_DISPATCH_ID");
  const namespace = required("AGORA_NAMESPACE");
  const storageUri = required("AGORA_STORAGE_URI");
  const bundleRefsRaw = required("AGORA_BUNDLE_REFS_JSON");

  let bundleRefs: BundleRefs;
  try {
    bundleRefs = JSON.parse(bundleRefsRaw) as BundleRefs;
  } catch (err) {
    throw new Error(
      `agora-worker: AGORA_BUNDLE_REFS_JSON is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (
    !bundleRefs ||
    typeof bundleRefs !== "object" ||
    !bundleRefs.subagent ||
    !Array.isArray(bundleRefs.capabilities) ||
    !Array.isArray(bundleRefs.env)
  ) {
    throw new Error(
      `agora-worker: AGORA_BUNDLE_REFS_JSON missing subagent / capabilities / env fields`,
    );
  }

  let inputJson: Record<string, unknown> = {};
  if (env.AGORA_INPUT_JSON) {
    try {
      inputJson = JSON.parse(env.AGORA_INPUT_JSON) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `agora-worker: AGORA_INPUT_JSON is not valid JSON: ${(err as Error).message}`,
      );
    }
  }

  let perDispatchSecretRefs: Record<string, string> = {};
  if (env.AGORA_PER_DISPATCH_SECRET_REFS_JSON) {
    try {
      perDispatchSecretRefs = JSON.parse(
        env.AGORA_PER_DISPATCH_SECRET_REFS_JSON,
      ) as Record<string, string>;
    } catch (err) {
      throw new Error(
        `agora-worker: AGORA_PER_DISPATCH_SECRET_REFS_JSON is not valid JSON: ${(err as Error).message}`,
      );
    }
  }

  const secretStoreDir = env.AGORA_SECRET_STORE_DIR || undefined;

  const VALID_SECRET_STORE_KINDS = ["aws-secrets-manager", "local-file"] as const;
  const rawKind = env.AGORA_SECRET_STORE_KIND ?? "aws-secrets-manager";
  if (!(VALID_SECRET_STORE_KINDS as readonly string[]).includes(rawKind)) {
    throw new Error(
      `agora-worker: AGORA_SECRET_STORE_KIND must be one of ${VALID_SECRET_STORE_KINDS.join(", ")}, got: ${rawKind}`,
    );
  }
  const secretStoreKind = rawKind as WorkerConfig["secretStoreKind"];

  const callbackUrl = env.AGORA_CALLBACK_URL;
  const callbackTokenRef = env.AGORA_CALLBACK_TOKEN_REF;
  if (callbackUrl && !callbackTokenRef) {
    throw new Error(
      `agora-worker: AGORA_CALLBACK_URL set without AGORA_CALLBACK_TOKEN_REF`,
    );
  }

  const runtimeAdapter = env.AGORA_RUNTIME_ADAPTER || "claude-code";
  const setupTimeoutSeconds = env.AGORA_SETUP_TIMEOUT_SECONDS
    ? parsePositiveInteger(env.AGORA_SETUP_TIMEOUT_SECONDS, "AGORA_SETUP_TIMEOUT_SECONDS")
    : 120;
  const disableNeedsInputHelper =
    env.AGORA_DISABLE_NEEDS_INPUT_HELPER === "true";

  return {
    dispatchId,
    namespace,
    storageUri,
    bundleRefs,
    inputJson,
    callbackUrl,
    callbackTokenRef,
    perDispatchSecretRefs,
    secretStoreDir,
    secretStoreKind,
    runtimeAdapter,
    setupTimeoutSeconds,
    disableNeedsInputHelper,
  };
}
