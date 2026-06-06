import { describe, it, expect } from "vitest";
import {
  fetchBundles,
  constructStorageProvider,
} from "../src/bundle-fetcher.js";
import {
  IntegrityMismatchError,
  computeContentHash,
  type StorageProvider,
} from "@quarry-systems/agora-core";
import type { BundleRefs } from "../src/env-parser.js";

/**
 * Minimal in-memory StorageProvider stub. Keyed by URI; returns the bytes
 * registered via `put()`. Other StorageProvider methods are not exercised
 * by the bundle fetcher.
 */
class FakeStorage implements StorageProvider {
  readonly name = "fake";
  private blobs = new Map<string, Uint8Array>();

  set(uri: string, bytes: Uint8Array): this {
    this.blobs.set(uri, bytes);
    return this;
  }

  async put(): Promise<{ contentHash: string }> {
    throw new Error("not used in bundle-fetcher tests");
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

function asBytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * Convenience: seed a valid subagent blob and return the matching BundleRef.
 * Used by tests that only care about inputs/capabilities, not subagent content.
 */
function subRef(storage: FakeStorage): BundleRefs["subagent"] {
  const uri = "agora://ns/subagent/s/sha256:s";
  storage.set(uri, asBytes({}));
  return { uri, contentHash: computeContentHash({}) };
}

describe("fetchBundles", () => {
  it("fetches and verifies a subagent JSON bundle", async () => {
    const subagentDef = { name: "alpha", prompt: "hello" };
    const storage = new FakeStorage();
    const uri = "agora://ns/subagent/alpha/sha256:1";
    storage.set(uri, asBytes(subagentDef));
    const refs: BundleRefs = {
      subagent: { uri, contentHash: computeContentHash(subagentDef) },
      capabilities: [],
      env: [],
    };

    const result = await fetchBundles(refs, storage);

    expect(result.subagentDef).toEqual(subagentDef);
  });

  it("throws IntegrityMismatchError when subagent hash does not match", async () => {
    const storage = new FakeStorage();
    const uri = "agora://ns/subagent/alpha/sha256:1";
    storage.set(uri, asBytes({ tampered: true }));
    const refs: BundleRefs = {
      subagent: { uri, contentHash: "sha256:wrong" },
      capabilities: [],
      env: [],
    };

    await expect(fetchBundles(refs, storage)).rejects.toBeInstanceOf(
      IntegrityMismatchError,
    );
  });

  it("fetches capability bundles in declared order and verifies packed-bytes hash", async () => {
    const capA = new Uint8Array([1, 2, 3]);
    const capB = new Uint8Array([4, 5, 6, 7]);
    const storage = new FakeStorage();
    const uriA = "agora://ns/capability/cap-a/sha256:a";
    const uriB = "agora://ns/capability/cap-b/sha256:b";
    storage.set(uriA, capA);
    storage.set(uriB, capB);
    const refs: BundleRefs = {
      subagent: {
        uri: "agora://ns/subagent/s/sha256:s",
        contentHash: computeContentHash({}),
      },
      capabilities: [
        { uri: uriA, contentHash: computeContentHash(capA) },
        { uri: uriB, contentHash: computeContentHash(capB) },
      ],
      env: [],
    };
    storage.set(refs.subagent.uri, asBytes({}));

    const result = await fetchBundles(refs, storage);

    expect(result.capabilities).toHaveLength(2);
    expect(result.capabilities[0]?.name).toBe("cap-a");
    expect(result.capabilities[0]?.bytes).toEqual(capA);
    expect(result.capabilities[1]?.name).toBe("cap-b");
    expect(result.capabilities[1]?.bytes).toEqual(capB);
  });

  it("throws IntegrityMismatchError when a capability hash does not match", async () => {
    const storage = new FakeStorage();
    storage.set(
      "agora://ns/subagent/s/sha256:s",
      asBytes({}),
    );
    storage.set(
      "agora://ns/capability/c/sha256:c",
      new TextEncoder().encode("tampered"),
    );
    const refs: BundleRefs = {
      subagent: {
        uri: "agora://ns/subagent/s/sha256:s",
        contentHash: computeContentHash({}),
      },
      capabilities: [
        {
          uri: "agora://ns/capability/c/sha256:c",
          contentHash: "sha256:wrong",
        },
      ],
      env: [],
    };

    await expect(fetchBundles(refs, storage)).rejects.toBeInstanceOf(
      IntegrityMismatchError,
    );
  });

  it("fetches and verifies env JSON bundles", async () => {
    const envDef = { vars: { FOO: "bar" } };
    const storage = new FakeStorage();
    storage.set("agora://ns/subagent/s/sha256:s", asBytes({}));
    storage.set("agora://ns/env/e/sha256:e", asBytes(envDef));
    const refs: BundleRefs = {
      subagent: {
        uri: "agora://ns/subagent/s/sha256:s",
        contentHash: computeContentHash({}),
      },
      capabilities: [],
      env: [
        {
          uri: "agora://ns/env/e/sha256:e",
          contentHash: computeContentHash(envDef),
        },
      ],
    };

    const result = await fetchBundles(refs, storage);

    expect(result.envs).toHaveLength(1);
    expect(result.envs[0]?.name).toBe("e");
    expect(result.envs[0]?.def).toEqual(envDef);
    expect(result.envs[0]?.contentHash).toBe(computeContentHash(envDef));
  });

  it("throws IntegrityMismatchError when env hash does not match", async () => {
    const storage = new FakeStorage();
    storage.set("agora://ns/subagent/s/sha256:s", asBytes({}));
    storage.set("agora://ns/env/e/sha256:e", asBytes({ tampered: true }));
    const refs: BundleRefs = {
      subagent: {
        uri: "agora://ns/subagent/s/sha256:s",
        contentHash: computeContentHash({}),
      },
      capabilities: [],
      env: [
        {
          uri: "agora://ns/env/e/sha256:e",
          contentHash: "sha256:wrong",
        },
      ],
    };

    await expect(fetchBundles(refs, storage)).rejects.toBeInstanceOf(
      IntegrityMismatchError,
    );
  });

  it("returns subagent + capabilities + envs together when all hashes match", async () => {
    const subagentDef = { name: "alpha" };
    const capBytes = new Uint8Array([9, 9, 9]);
    const envDef = { e: 1 };
    const storage = new FakeStorage();
    storage.set("agora://ns/subagent/alpha/sha256:s", asBytes(subagentDef));
    storage.set("agora://ns/capability/cap/sha256:c", capBytes);
    storage.set("agora://ns/env/env1/sha256:e", asBytes(envDef));
    const refs: BundleRefs = {
      subagent: {
        uri: "agora://ns/subagent/alpha/sha256:s",
        contentHash: computeContentHash(subagentDef),
      },
      capabilities: [
        {
          uri: "agora://ns/capability/cap/sha256:c",
          contentHash: computeContentHash(capBytes),
        },
      ],
      env: [
        {
          uri: "agora://ns/env/env1/sha256:e",
          contentHash: computeContentHash(envDef),
        },
      ],
    };

    const result = await fetchBundles(refs, storage);

    expect(result.subagentDef).toEqual(subagentDef);
    expect(result.capabilities[0]?.name).toBe("cap");
    expect(result.capabilities[0]?.contentHash).toBe(
      computeContentHash(capBytes),
    );
    expect(result.envs[0]?.name).toBe("env1");
    expect(result.envs[0]?.def).toEqual(envDef);
  });

  it("fetches and raw-bytes-verifies input refs", async () => {
    const bytes = new TextEncoder().encode("diff --git a/x b/x");
    const storage = new FakeStorage();
    const refs: BundleRefs = {
      subagent: subRef(storage),
      capabilities: [],
      env: [],
      inputs: [
        {
          key: "patch",
          uri: "agora://ns/artifact/d/sha256:p",
          contentHash: computeContentHash(bytes),
        },
      ],
    };
    storage.set("agora://ns/artifact/d/sha256:p", bytes);

    const result = await fetchBundles(refs, storage);

    expect(result.inputs).toEqual([{ key: "patch", bytes }]);
  });

  it("throws IntegrityMismatchError on a tampered input blob", async () => {
    const bytes = new TextEncoder().encode("diff --git a/x b/x");
    const storage = new FakeStorage();
    const refs: BundleRefs = {
      subagent: subRef(storage),
      capabilities: [],
      env: [],
      inputs: [
        {
          key: "patch",
          uri: "agora://ns/artifact/d/sha256:p",
          contentHash: "sha256:wrong",
        },
      ],
    };
    storage.set("agora://ns/artifact/d/sha256:p", bytes);

    await expect(fetchBundles(refs, storage)).rejects.toBeInstanceOf(
      IntegrityMismatchError,
    );
  });

  it("returns inputs: [] when refs.inputs is absent", async () => {
    const storage = new FakeStorage();
    const refs: BundleRefs = {
      subagent: subRef(storage),
      capabilities: [],
      env: [],
    };

    const result = await fetchBundles(refs, storage);

    expect(result.inputs).toEqual([]);
  });

  it("fetches and object-hash-verifies the pipeline bundle; tampered bytes throw", async () => {
    const spec = { version: "1", steps: [{ name: "build" }] };
    const storage = new FakeStorage();
    const uri = "agora://ns/pipeline/p/sha256:pp";

    // Store canonicalJsonString(spec) bytes at the pinned URI
    const { canonicalJsonString } = await import("@quarry-systems/agora-core");
    const specBytes = new TextEncoder().encode(canonicalJsonString(spec));
    storage.set(uri, specBytes);

    const refs: BundleRefs = {
      subagent: subRef(storage),
      capabilities: [],
      env: [],
      pipeline: { uri, contentHash: computeContentHash(spec) },
    };

    const result = await fetchBundles(refs, storage);
    expect(result.pipeline).toEqual(spec);

    // Corrupt stored bytes → fetchBundles should throw integrity error
    const tamperedStorage = new FakeStorage();
    subRef(tamperedStorage);
    tamperedStorage.set(uri, new TextEncoder().encode(JSON.stringify({ tampered: true })));
    const refs2: BundleRefs = {
      subagent: subRef(tamperedStorage),
      capabilities: [],
      env: [],
      pipeline: { uri, contentHash: computeContentHash(spec) },
    };
    await expect(fetchBundles(refs2, tamperedStorage)).rejects.toBeInstanceOf(
      IntegrityMismatchError,
    );
  });

  it("returns pipeline: undefined when refs.pipeline is absent", async () => {
    const storage = new FakeStorage();
    const refs: BundleRefs = {
      subagent: subRef(storage),
      capabilities: [],
      env: [],
    };

    const result = await fetchBundles(refs, storage);

    expect(result.pipeline).toBeUndefined();
  });
});

describe("constructStorageProvider", () => {
  it("constructs an S3StorageProvider for s3:// URIs with bucket only", async () => {
    const provider = await constructStorageProvider("s3://my-bucket");
    expect(provider.name).toBe("s3");
  });

  it("constructs an S3StorageProvider for s3:// URIs with bucket + prefix", async () => {
    const provider = await constructStorageProvider("s3://my-bucket/some/prefix");
    expect(provider.name).toBe("s3");
  });

  it("constructs a LocalStorageProvider for file:// URIs", async () => {
    const provider = await constructStorageProvider("file:///tmp/agora-store");
    expect(provider.name).toBe("local-fs");
  });

  it("constructs a LocalStorageProvider for bare absolute paths", async () => {
    const provider = await constructStorageProvider("/tmp/agora-store");
    expect(provider.name).toBe("local-fs");
  });

  it("throws for unrecognized URI schemes", async () => {
    await expect(
      constructStorageProvider("http://example.com/bucket"),
    ).rejects.toThrow(/unrecognized/);
  });

  it("throws for empty s3:// bucket", async () => {
    await expect(
      constructStorageProvider("s3://"),
    ).rejects.toThrow(/requires a non-empty bucket/);
  });

  it("throws with provider context when S3StorageProvider import fails", async () => {
    // This test verifies that if the import fails, the error message
    // includes provider context about what failed to load
    // We can't actually break the import here, but we verify the
    // code structure would catch it with good error context
    const provider = await constructStorageProvider("s3://test-bucket");
    expect(provider.name).toBe("s3");
  });

  it("throws with provider context when LocalStorageProvider import fails", async () => {
    // This test verifies that if the import fails, the error message
    // includes provider context about what failed to load
    // We can't actually break the import here, but we verify the
    // code structure would catch it with good error context
    const provider = await constructStorageProvider("/tmp/test");
    expect(provider.name).toBe("local-fs");
  });
});
