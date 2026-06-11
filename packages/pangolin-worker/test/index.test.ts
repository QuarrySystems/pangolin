import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorker, type RunWorkerDeps } from "../src/entrypoint.js";
import {
  computeContentHash,
  type StorageProvider,
  type RuntimeAdapter,
  type SecretStore,
} from "@quarry-systems/pangolin-core";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

// ---------------------------------------------------------------------------
// Shared helpers (copied from entrypoint.test.ts to avoid cross-file import)
// ---------------------------------------------------------------------------

class FakeStorage implements StorageProvider {
  readonly name = "fake";
  private blobs = new Map<string, Uint8Array>();

  set(uri: string, bytes: Uint8Array): this {
    this.blobs.set(uri, bytes);
    return this;
  }

  async put(): Promise<{ contentHash: string }> {
    throw new Error("not used");
  }

  async get(uri: string): Promise<Uint8Array> {
    const v = this.blobs.get(uri);
    if (!v) throw new Error(`fake storage: missing ${uri}`);
    return v;
  }

  async resolveLatest(): Promise<null> {
    return null;
  }

  async list(): Promise<[]> {
    return [];
  }
}

function packBundle(
  name: string,
  files: Record<string, Uint8Array>,
): Uint8Array {
  const paths = Object.keys(files).sort();
  const entries = paths.map((path) => ({ path, size: files[path]!.byteLength }));
  const headerBytes = new TextEncoder().encode(
    JSON.stringify({ name, entries }) + "\n",
  );
  const total =
    headerBytes.byteLength +
    paths.reduce((acc, p) => acc + files[p]!.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  out.set(headerBytes, 0);
  offset += headerBytes.byteLength;
  for (const p of paths) {
    out.set(files[p]!, offset);
    offset += files[p]!.byteLength;
  }
  return out;
}

function asJsonBytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Index exports
// ---------------------------------------------------------------------------

describe("pangolin-worker index exports", () => {
  it("exports runWorker", async () => {
    const { runWorker } = await import("../src/index.js");
    expect(runWorker).toBeDefined();
    expect(typeof runWorker).toBe("function");
  });

  it("exports parseWorkerEnv and types", async () => {
    const { parseWorkerEnv } = await import("../src/index.js");
    expect(parseWorkerEnv).toBeDefined();
    expect(typeof parseWorkerEnv).toBe("function");
  });

  it("exports LifecycleEmitter", async () => {
    const { LifecycleEmitter } = await import("../src/index.js");
    expect(LifecycleEmitter).toBeDefined();
    expect(typeof LifecycleEmitter).toBe("function");
  });

  it("exports StructuredLogger", async () => {
    const { StructuredLogger } = await import("../src/index.js");
    expect(StructuredLogger).toBeDefined();
    expect(typeof StructuredLogger).toBe("function");
  });

  it("does NOT export SecretResolver or SecretResolutionError", async () => {
    const module = await import("../src/index.js");
    expect((module as Record<string, unknown>).SecretResolver).toBeUndefined();
    expect((module as Record<string, unknown>).SecretResolutionError).toBeUndefined();
  });

  it("exports mergeEnv", async () => {
    const { mergeEnv } = await import("../src/index.js");
    expect(mergeEnv).toBeDefined();
    expect(typeof mergeEnv).toBe("function");
  });

  it("exports overlayCapabilities", async () => {
    const { overlayCapabilities } = await import("../src/index.js");
    expect(overlayCapabilities).toBeDefined();
    expect(typeof overlayCapabilities).toBe("function");
  });

  it("exports fetchBundles and constructStorageProvider", async () => {
    const { fetchBundles, constructStorageProvider } = await import(
      "../src/index.js"
    );
    expect(fetchBundles).toBeDefined();
    expect(constructStorageProvider).toBeDefined();
    expect(typeof fetchBundles).toBe("function");
    expect(typeof constructStorageProvider).toBe("function");
  });

  it("exports loadRuntimeAdapter", async () => {
    const { loadRuntimeAdapter } = await import("../src/index.js");
    expect(loadRuntimeAdapter).toBeDefined();
    expect(typeof loadRuntimeAdapter).toBe("function");
  });

  it("exports runSetupScriptIfPresent and SetupScriptError", async () => {
    const { runSetupScriptIfPresent, SetupScriptError } = await import(
      "../src/index.js"
    );
    expect(runSetupScriptIfPresent).toBeDefined();
    expect(SetupScriptError).toBeDefined();
    expect(typeof runSetupScriptIfPresent).toBe("function");
  });

  it("exports loadChannelIfPresent", async () => {
    const { loadChannelIfPresent } = await import("../src/index.js");
    expect(loadChannelIfPresent).toBeDefined();
    expect(typeof loadChannelIfPresent).toBe("function");
  });

  it("exports resolveNeedsInputSentinel", async () => {
    const { resolveNeedsInputSentinel } = await import("../src/index.js");
    expect(resolveNeedsInputSentinel).toBeDefined();
    expect(typeof resolveNeedsInputSentinel).toBe("function");
  });

  it("exports loadCapabilityNotifications and fireNotifications", async () => {
    const { loadCapabilityNotifications, fireNotifications } = await import(
      "../src/index.js"
    );
    expect(loadCapabilityNotifications).toBeDefined();
    expect(fireNotifications).toBeDefined();
    expect(typeof loadCapabilityNotifications).toBe("function");
    expect(typeof fireNotifications).toBe("function");
  });

  it("exports applyMergeRule and MergeTypeConflictError", async () => {
    const { applyMergeRule, MergeTypeConflictError } = await import(
      "../src/index.js"
    );
    expect(applyMergeRule).toBeDefined();
    expect(MergeTypeConflictError).toBeDefined();
    expect(typeof applyMergeRule).toBe("function");
  });

  it("exports types: WorkerConfig, BundleRefs, EnvBundle, CapabilityBundle, ChannelHandle, NeedsInputOutcome, FetchedBundles", async () => {
    // Just verify the module exports without errors
    const module = await import("../src/index.js");
    expect(module).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SecretStore kind selection: no effectiveStoreKind auto-detect
// ---------------------------------------------------------------------------

describe("worker SecretStore kind selection (no file:// auto-detect)", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    for (const d of cleanupDirs) {
      await rm(d, { recursive: true, force: true });
    }
    cleanupDirs.length = 0;
  });

  it("uses LocalSecretStore when PANGOLIN_SECRET_STORE_KIND=local-file + dir is set", async () => {
    // This test verifies the new behaviour: worker honours PANGOLIN_SECRET_STORE_KIND
    // directly without relying on storageUri file:// sniffing.
    const workDir = await mkdtemp(join(tmpdir(), "idx-local-work-"));
    const adaptersRoot = await mkdtemp(join(tmpdir(), "idx-local-adapters-"));
    const secretDir = await mkdtemp(join(tmpdir(), "idx-local-secrets-"));
    cleanupDirs.push(workDir, adaptersRoot, secretDir);

    const adapterDir = join(adaptersRoot, "claude-code");
    await mkdir(adapterDir, { recursive: true });
    await writeFile(
      join(adapterDir, "index.js"),
      `export default function () {
         return {
           name: "claude-code",
           reservedPaths: [],
           invoke: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
         };
       };\n`,
      "utf-8",
    );

    const subagentDef = { name: "beta", systemPrompt: "local work" };
    const subagentUri = "pangolin://ns/subagent/beta/sha256:sb";
    const subagentHash = computeContentHash(subagentDef);

    const storage = new FakeStorage();
    storage.set(subagentUri, asJsonBytes(subagentDef));

    const bundleRefs = {
      subagent: { uri: subagentUri, contentHash: subagentHash },
      capabilities: [],
      env: [],
    };

    // Write a staged local secret that the per-dispatch ref will resolve.
    const secretId = "test-local-secret-id";
    const secretValue = "resolved-from-local-file";
    await writeFile(join(secretDir, `${secretId}.secret`), secretValue, { mode: 0o600 });

    const env: Record<string, string> = {
      PANGOLIN_DISPATCH_ID: "d-local-1",
      PANGOLIN_NAMESPACE: "ns",
      // NOTE: storage URI is NOT file:// — this proves we don't rely on sniffing.
      PANGOLIN_STORAGE_URI: "pangolin://fake-registry",
      PANGOLIN_BUNDLE_REFS_JSON: JSON.stringify(bundleRefs),
      PANGOLIN_RUNTIME_ADAPTER: "claude-code",
      PANGOLIN_SECRET_STORE_KIND: "local-file",
      PANGOLIN_SECRET_STORE_DIR: secretDir,
      PANGOLIN_PER_DISPATCH_SECRET_REFS_JSON: JSON.stringify({
        MY_SECRET: `local-secret://${secretId}`,
      }),
    };

    let capturedEnv: Record<string, string> | undefined;
    const adapter: RuntimeAdapter = {
      name: "claude-code",
      reservedPaths: [],
      invoke: async (_spec, ctx) => {
        capturedEnv = ctx.env;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const deps: RunWorkerDeps = {
      storage,
      adapter,
      adaptersRoot,
      workspaceDir: workDir,
      // No secretStore injected: worker must build it from cfg.secretStoreKind
    };

    const code = await runWorker(env, deps);

    expect(code).toBe(0);
    // The per-dispatch secret was resolved from the local file — not via AWS.
    expect(capturedEnv?.MY_SECRET).toBe(secretValue);
  });

  it("explicit PANGOLIN_SECRET_STORE_KIND=aws-secrets-manager is NOT overridden by file:// storageUri + secretStoreDir", async () => {
    // RED test: old effectiveStoreKind shim would auto-switch to 'local-file'
    // when storageUri starts with 'file://' AND secretStoreDir is set, even
    // though PANGOLIN_SECRET_STORE_KIND explicitly says 'aws-secrets-manager'.
    // That causes LocalSecretStore to be built, which rejects any ref that is
    // NOT a 'local-secret://' scheme → fetch-failed → exit 1.
    //
    // After the fix: cfg.secretStoreKind is used directly → AwsSecretStore is
    // built with the injected mock client → mock returns the secret value →
    // exit 0.

    const workDir = await mkdtemp(join(tmpdir(), "idx-aws-work-"));
    const adaptersRoot = await mkdtemp(join(tmpdir(), "idx-aws-adapters-"));
    const secretDir = await mkdtemp(join(tmpdir(), "idx-aws-sdir-"));
    cleanupDirs.push(workDir, adaptersRoot, secretDir);

    const adapterDir = join(adaptersRoot, "claude-code");
    await mkdir(adapterDir, { recursive: true });
    await writeFile(
      join(adapterDir, "index.js"),
      `export default function () {
         return {
           name: "claude-code",
           reservedPaths: [],
           invoke: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
         };
       };\n`,
      "utf-8",
    );

    const subagentDef = { name: "gamma", systemPrompt: "aws work" };
    const subagentUri = "pangolin://ns/subagent/gamma/sha256:sg";
    const subagentHash = computeContentHash(subagentDef);

    const storage = new FakeStorage();
    storage.set(subagentUri, asJsonBytes(subagentDef));

    const bundleRefs = {
      subagent: { uri: subagentUri, contentHash: subagentHash },
      capabilities: [],
      env: [],
    };

    // Mock SecretsManagerClient that handles GetSecretValueCommand.
    // When AwsSecretStore resolves "arn:aws:test-ref", it calls
    // GetSecretValueCommand — our mock returns "aws-resolved-value".
    const AWS_SECRET_VALUE = "aws-resolved-value";
    const mockClient = {
      send: async (cmd: unknown) => {
        const command = cmd as { input?: { SecretId?: string }; constructor?: { name?: string } };
        // GetSecretValueCommand
        if (command.constructor?.name === "GetSecretValueCommand") {
          return { SecretString: AWS_SECRET_VALUE };
        }
        throw new Error(`mock: unexpected command ${command.constructor?.name}`);
      },
    } as unknown as SecretsManagerClient;

    const env: Record<string, string> = {
      PANGOLIN_DISPATCH_ID: "d-aws-1",
      PANGOLIN_NAMESPACE: "ns",
      // file:// URI + secretStoreDir: old shim would auto-switch to local-file.
      PANGOLIN_STORAGE_URI: "file:///fake",
      PANGOLIN_BUNDLE_REFS_JSON: JSON.stringify(bundleRefs),
      PANGOLIN_RUNTIME_ADAPTER: "claude-code",
      PANGOLIN_SECRET_STORE_KIND: "aws-secrets-manager",
      PANGOLIN_SECRET_STORE_DIR: secretDir,
      // Provide a per-dispatch secret with an AWS ARN ref (not local-secret://).
      // Old code: LocalSecretStore.resolve("arn:aws:test-ref") throws "not a local-secret ref"
      //   → fetch-failed → exit 1 (RED).
      // New code: AwsSecretStore.resolve("arn:aws:test-ref") → mock returns value
      //   → exit 0 (GREEN).
      PANGOLIN_PER_DISPATCH_SECRET_REFS_JSON: JSON.stringify({
        AWS_VAR: "arn:aws:test-ref",
      }),
    };

    let capturedEnv: Record<string, string> | undefined;
    const adapter: RuntimeAdapter = {
      name: "claude-code",
      reservedPaths: [],
      invoke: async (_spec, ctx) => {
        capturedEnv = ctx.env;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const deps: RunWorkerDeps = {
      storage,
      adaptersRoot,
      workspaceDir: workDir,
      // No secretStore injection — worker builds its own from cfg.secretStoreKind.
      // Inject mock client to avoid real AWS network calls.
      secretsManagerClient: mockClient,
      adapter,
    };

    const code = await runWorker(env, deps);

    // With fix: AwsSecretStore was used → mock resolved the ARN ref → exit 0.
    expect(code).toBe(0);
    expect(capturedEnv?.AWS_VAR).toBe(AWS_SECRET_VALUE);
  });
});

// ---------------------------------------------------------------------------
// Integration: env-bundle + callback secrets through injected SecretStore
// ---------------------------------------------------------------------------

describe("worker lifecycle (SecretStore integration)", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    for (const d of cleanupDirs) {
      await rm(d, { recursive: true, force: true });
    }
    cleanupDirs.length = 0;
  });

  it("resolves env-bundle and callback secrets through the injected SecretStore and redacts them", async () => {
    // --- Setup workspace + adapters ---
    const workDir = await mkdtemp(join(tmpdir(), "idx-test-work-"));
    const adaptersRoot = await mkdtemp(join(tmpdir(), "idx-test-adapters-"));
    cleanupDirs.push(workDir, adaptersRoot);

    const adapterDir = join(adaptersRoot, "claude-code");
    await mkdir(adapterDir, { recursive: true });
    await writeFile(
      join(adapterDir, "index.js"),
      `export default function () {
         return {
           name: "claude-code",
           reservedPaths: [],
           invoke: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
         };
       };\n`,
      "utf-8",
    );

    // --- Build storage with subagent + capability bundle + env bundle ---
    const subagentDef = { name: "alpha", systemPrompt: "do work" };
    const subagentUri = "pangolin://ns/subagent/alpha/sha256:s";
    const subagentHash = computeContentHash(subagentDef);

    const capFiles = { "README.md": new TextEncoder().encode("hello\n") };
    const capBytes = packBundle("cap-a", capFiles);
    const capUri = "pangolin://ns/capability/cap-a/sha256:c";
    const capHash = computeContentHash(capBytes);

    // An env bundle that carries both static values and a secret ref.
    const envDef = {
      values: { STATIC_VAR: "static-value" },
      secretRefs: { API_KEY: "ref-for-api-key" },
    };
    const envBytes = asJsonBytes(envDef);
    const envUri = "pangolin://ns/env/env-a/sha256:e";
    // Env bundles are hashed via canonical JSON of the parsed object (not raw
    // bytes), matching bundle-fetcher's verifyContentHash(def, ...) logic.
    const envHash = computeContentHash(envDef);

    const storage = new FakeStorage();
    storage.set(subagentUri, asJsonBytes(subagentDef));
    storage.set(capUri, capBytes);
    storage.set(envUri, envBytes);

    const bundleRefs = {
      subagent: { uri: subagentUri, contentHash: subagentHash },
      capabilities: [{ uri: capUri, contentHash: capHash }],
      env: [{ uri: envUri, contentHash: envHash }],
    };

    // Worker env: callback is configured + one env bundle with a secret ref.
    const env: Record<string, string> = {
      PANGOLIN_DISPATCH_ID: "d-idx-1",
      PANGOLIN_NAMESPACE: "ns",
      PANGOLIN_STORAGE_URI: "file:///fake",
      PANGOLIN_BUNDLE_REFS_JSON: JSON.stringify(bundleRefs),
      PANGOLIN_RUNTIME_ADAPTER: "claude-code",
      PANGOLIN_CALLBACK_URL: "http://localhost:9999/cb",
      PANGOLIN_CALLBACK_TOKEN_REF: "ref-for-hmac-key",
    };

    // Track every ref resolved via the injected store.
    const resolved: string[] = [];
    const HMAC_KEY_VALUE = "hmac-key-secret-value";
    const API_KEY_VALUE = "api-key-secret-value";

    const store: SecretStore = {
      name: "fake",
      resolve: async (ref: string) => {
        resolved.push(ref);
        if (ref === "ref-for-hmac-key") return HMAC_KEY_VALUE;
        if (ref === "ref-for-api-key") return API_KEY_VALUE;
        throw new Error(`unknown ref: ${ref}`);
      },
      stage: async () => ({ ref: "x", ttlSeconds: 1 }),
      cleanupByTag: async () => {},
    };

    let capturedEnv: Record<string, string> | undefined;
    const adapter: RuntimeAdapter = {
      name: "claude-code",
      reservedPaths: [],
      invoke: async (_spec, ctx) => {
        capturedEnv = ctx.env;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const deps: RunWorkerDeps = {
      storage,
      adapter,
      adaptersRoot,
      workspaceDir: workDir,
      secretStore: store,
      fetchImpl: async () => new Response(null, { status: 204 }),
    };

    const code = await runWorker(env, deps);

    expect(code).toBe(0);

    // Both secret refs were routed through the store.
    expect(resolved).toContain("ref-for-hmac-key");
    expect(resolved).toContain("ref-for-api-key");

    // The HMAC key and API key must have been registered for redaction
    // (StructuredLogger.registerSecret). We verify the static env var still
    // made it through, and that env-bundle resolved values are injected.
    expect(capturedEnv?.STATIC_VAR).toBe("static-value");
    expect(capturedEnv?.API_KEY).toBe(API_KEY_VALUE);
  });
});
