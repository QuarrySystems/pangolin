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
  runtimeAdapter: string;
  setupTimeoutSeconds: number;
  disableNeedsInputHelper: boolean;
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

  const callbackUrl = env.AGORA_CALLBACK_URL;
  const callbackTokenRef = env.AGORA_CALLBACK_TOKEN_REF;
  if (callbackUrl && !callbackTokenRef) {
    throw new Error(
      `agora-worker: AGORA_CALLBACK_URL set without AGORA_CALLBACK_TOKEN_REF`,
    );
  }

  const runtimeAdapter = env.AGORA_RUNTIME_ADAPTER || "claude-code";
  const setupTimeoutSeconds = env.AGORA_SETUP_TIMEOUT_SECONDS
    ? Number(env.AGORA_SETUP_TIMEOUT_SECONDS)
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
    runtimeAdapter,
    setupTimeoutSeconds,
    disableNeedsInputHelper,
  };
}
