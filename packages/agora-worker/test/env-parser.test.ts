import { describe, it, expect } from "vitest";
import { parseWorkerEnv } from "../src/env-parser.js";

const validBundleRefs = JSON.stringify({
  subagent: { uri: "s3://b/sub", contentHash: "sha256:aaa" },
  capabilities: [{ uri: "s3://b/cap", contentHash: "sha256:bbb" }],
  env: [{ uri: "s3://b/env", contentHash: "sha256:ccc" }],
});

function baseEnv(): NodeJS.ProcessEnv {
  return {
    AGORA_DISPATCH_ID: "d-123",
    AGORA_NAMESPACE: "ns-1",
    AGORA_STORAGE_URI: "s3://bucket/prefix",
    AGORA_BUNDLE_REFS_JSON: validBundleRefs,
  };
}

describe("parseWorkerEnv", () => {
  describe("required vars", () => {
    it("throws when AGORA_DISPATCH_ID is missing", () => {
      expect(() => parseWorkerEnv({})).toThrow(/AGORA_DISPATCH_ID/);
    });

    it("throws when AGORA_NAMESPACE is missing", () => {
      const env = baseEnv();
      delete env.AGORA_NAMESPACE;
      expect(() => parseWorkerEnv(env)).toThrow(/AGORA_NAMESPACE/);
    });

    it("throws when AGORA_STORAGE_URI is missing", () => {
      const env = baseEnv();
      delete env.AGORA_STORAGE_URI;
      expect(() => parseWorkerEnv(env)).toThrow(/AGORA_STORAGE_URI/);
    });

    it("throws when AGORA_BUNDLE_REFS_JSON is missing", () => {
      const env = baseEnv();
      delete env.AGORA_BUNDLE_REFS_JSON;
      expect(() => parseWorkerEnv(env)).toThrow(/AGORA_BUNDLE_REFS_JSON/);
    });
  });

  describe("per-dispatch secret refs", () => {
    it("defaults perDispatchSecretRefs to an empty object when unset", () => {
      const cfg = parseWorkerEnv(baseEnv());
      expect(cfg.perDispatchSecretRefs).toEqual({});
    });

    it("parses AGORA_PER_DISPATCH_SECRET_REFS_JSON into envName→ref map", () => {
      const env = baseEnv();
      env.AGORA_PER_DISPATCH_SECRET_REFS_JSON = JSON.stringify({
        GH_TOKEN: "arn:aws:secretsmanager:us-east-1:1:secret:gh",
        DEPLOY_KEY: "local-secret://abc",
      });
      const cfg = parseWorkerEnv(env);
      expect(cfg.perDispatchSecretRefs).toEqual({
        GH_TOKEN: "arn:aws:secretsmanager:us-east-1:1:secret:gh",
        DEPLOY_KEY: "local-secret://abc",
      });
    });

    it("throws when AGORA_PER_DISPATCH_SECRET_REFS_JSON is malformed JSON", () => {
      const env = baseEnv();
      env.AGORA_PER_DISPATCH_SECRET_REFS_JSON = "{not-json";
      expect(() => parseWorkerEnv(env)).toThrow(
        /AGORA_PER_DISPATCH_SECRET_REFS_JSON.*not valid JSON/,
      );
    });
  });

  describe("secret store dir", () => {
    it("leaves secretStoreDir undefined when AGORA_SECRET_STORE_DIR is unset", () => {
      expect(parseWorkerEnv(baseEnv()).secretStoreDir).toBeUndefined();
    });

    it("parses AGORA_SECRET_STORE_DIR into secretStoreDir", () => {
      const env = baseEnv();
      env.AGORA_SECRET_STORE_DIR = "/agora/secrets";
      expect(parseWorkerEnv(env).secretStoreDir).toBe("/agora/secrets");
    });
  });

  describe("bundle refs validation", () => {
    it("throws when AGORA_BUNDLE_REFS_JSON is malformed JSON", () => {
      const env = baseEnv();
      env.AGORA_BUNDLE_REFS_JSON = "{not-json";
      expect(() => parseWorkerEnv(env)).toThrow(/AGORA_BUNDLE_REFS_JSON.*not valid JSON/);
    });

    it("throws when bundle refs is missing subagent field", () => {
      const env = baseEnv();
      env.AGORA_BUNDLE_REFS_JSON = JSON.stringify({ capabilities: [], env: [] });
      expect(() => parseWorkerEnv(env)).toThrow(/subagent/);
    });

    it("throws when bundle refs capabilities is not an array", () => {
      const env = baseEnv();
      env.AGORA_BUNDLE_REFS_JSON = JSON.stringify({
        subagent: { uri: "s", contentHash: "h" },
        capabilities: "nope",
        env: [],
      });
      expect(() => parseWorkerEnv(env)).toThrow(/capabilities/);
    });

    it("throws when bundle refs env is not an array", () => {
      const env = baseEnv();
      env.AGORA_BUNDLE_REFS_JSON = JSON.stringify({
        subagent: { uri: "s", contentHash: "h" },
        capabilities: [],
        env: "nope",
      });
      expect(() => parseWorkerEnv(env)).toThrow(/env/);
    });

    it("parses bundle refs into typed structure", () => {
      const cfg = parseWorkerEnv(baseEnv());
      expect(cfg.bundleRefs.subagent).toEqual({ uri: "s3://b/sub", contentHash: "sha256:aaa" });
      expect(cfg.bundleRefs.capabilities).toHaveLength(1);
      expect(cfg.bundleRefs.env).toHaveLength(1);
    });
  });

  describe("input JSON", () => {
    it("defaults inputJson to empty object when AGORA_INPUT_JSON is absent", () => {
      const cfg = parseWorkerEnv(baseEnv());
      expect(cfg.inputJson).toEqual({});
    });

    it("parses AGORA_INPUT_JSON when present", () => {
      const env = baseEnv();
      env.AGORA_INPUT_JSON = JSON.stringify({ foo: 1, bar: "x" });
      const cfg = parseWorkerEnv(env);
      expect(cfg.inputJson).toEqual({ foo: 1, bar: "x" });
    });
  });

  describe("callback pairing", () => {
    it("throws when AGORA_CALLBACK_URL is set without AGORA_CALLBACK_TOKEN_REF", () => {
      const env = baseEnv();
      env.AGORA_CALLBACK_URL = "https://example.com/cb";
      expect(() => parseWorkerEnv(env)).toThrow(/CALLBACK_TOKEN_REF/);
    });

    it("accepts both callback url and token ref together", () => {
      const env = baseEnv();
      env.AGORA_CALLBACK_URL = "https://example.com/cb";
      env.AGORA_CALLBACK_TOKEN_REF = "secret://cb-token";
      const cfg = parseWorkerEnv(env);
      expect(cfg.callbackUrl).toBe("https://example.com/cb");
      expect(cfg.callbackTokenRef).toBe("secret://cb-token");
    });

    it("leaves callback fields undefined when neither set", () => {
      const cfg = parseWorkerEnv(baseEnv());
      expect(cfg.callbackUrl).toBeUndefined();
      expect(cfg.callbackTokenRef).toBeUndefined();
    });
  });

  describe("defaults", () => {
    it("defaults runtimeAdapter to claude-code", () => {
      const cfg = parseWorkerEnv(baseEnv());
      expect(cfg.runtimeAdapter).toBe("claude-code");
    });

    it("honours AGORA_RUNTIME_ADAPTER override", () => {
      const env = baseEnv();
      env.AGORA_RUNTIME_ADAPTER = "codex";
      expect(parseWorkerEnv(env).runtimeAdapter).toBe("codex");
    });

    it("defaults setupTimeoutSeconds to 120", () => {
      const cfg = parseWorkerEnv(baseEnv());
      expect(cfg.setupTimeoutSeconds).toBe(120);
    });

    it("parses AGORA_SETUP_TIMEOUT_SECONDS as a number", () => {
      const env = baseEnv();
      env.AGORA_SETUP_TIMEOUT_SECONDS = "300";
      expect(parseWorkerEnv(env).setupTimeoutSeconds).toBe(300);
    });

    it("throws when AGORA_SETUP_TIMEOUT_SECONDS is not a valid non-negative integer", () => {
      const env = baseEnv();
      env.AGORA_SETUP_TIMEOUT_SECONDS = "abc";
      expect(() => parseWorkerEnv(env)).toThrow(
        /AGORA_SETUP_TIMEOUT_SECONDS must be a non-negative integer/
      );
    });

    it("defaults disableNeedsInputHelper to false", () => {
      const cfg = parseWorkerEnv(baseEnv());
      expect(cfg.disableNeedsInputHelper).toBe(false);
    });

    it("disableNeedsInputHelper is true only when AGORA_DISABLE_NEEDS_INPUT_HELPER=true", () => {
      const env = baseEnv();
      env.AGORA_DISABLE_NEEDS_INPUT_HELPER = "true";
      expect(parseWorkerEnv(env).disableNeedsInputHelper).toBe(true);
    });

    it("disableNeedsInputHelper stays false for other truthy-ish strings", () => {
      const env = baseEnv();
      env.AGORA_DISABLE_NEEDS_INPUT_HELPER = "1";
      expect(parseWorkerEnv(env).disableNeedsInputHelper).toBe(false);
    });
  });

  describe("happy path", () => {
    it("returns a complete WorkerConfig from required vars only", () => {
      const cfg = parseWorkerEnv(baseEnv());
      expect(cfg.dispatchId).toBe("d-123");
      expect(cfg.namespace).toBe("ns-1");
      expect(cfg.storageUri).toBe("s3://bucket/prefix");
    });
  });

  describe("secret store kind", () => {
    it("defaults secretStoreKind to aws-secrets-manager when unset", () => {
      const cfg = parseWorkerEnv({ ...baseEnv() });
      expect(cfg.secretStoreKind).toBe("aws-secrets-manager");
    });
    it("reads local-file from AGORA_SECRET_STORE_KIND", () => {
      const cfg = parseWorkerEnv({ ...baseEnv(), AGORA_SECRET_STORE_KIND: "local-file" });
      expect(cfg.secretStoreKind).toBe("local-file");
    });
    it("accepts explicit aws-secrets-manager and round-trips correctly", () => {
      const cfg = parseWorkerEnv({ ...baseEnv(), AGORA_SECRET_STORE_KIND: "aws-secrets-manager" });
      expect(cfg.secretStoreKind).toBe("aws-secrets-manager");
    });
    it("throws with a clear message when AGORA_SECRET_STORE_KIND is unrecognized", () => {
      expect(() =>
        parseWorkerEnv({ ...baseEnv(), AGORA_SECRET_STORE_KIND: "typo-value" }),
      ).toThrow(/AGORA_SECRET_STORE_KIND/);
    });
  });

  describe("bundle refs pipeline", () => {
    it("tolerates absent pipeline field (old clients)", () => {
      const cfg = parseWorkerEnv(baseEnv());
      expect(cfg.bundleRefs.pipeline).toBeUndefined();
    });

    it("parses bundleRefs.pipeline when present", () => {
      const env = baseEnv();
      env.AGORA_BUNDLE_REFS_JSON = JSON.stringify({
        subagent: { uri: "s3://b/sub", contentHash: "sha256:aaa" },
        capabilities: [],
        env: [],
        pipeline: { uri: "agora://ns/pipeline/p/sha256:pp", contentHash: "sha256:pp" },
      });
      expect(parseWorkerEnv(env).bundleRefs.pipeline).toEqual({
        uri: "agora://ns/pipeline/p/sha256:pp",
        contentHash: "sha256:pp",
      });
    });

    it("throws when pipeline is not an object", () => {
      const env = baseEnv();
      env.AGORA_BUNDLE_REFS_JSON = JSON.stringify({
        subagent: { uri: "s3://b/sub", contentHash: "sha256:aaa" },
        capabilities: [],
        env: [],
        pipeline: "not-an-object",
      });
      expect(() => parseWorkerEnv(env)).toThrow(/AGORA_BUNDLE_REFS_JSON.*pipeline/);
    });

    it("throws when pipeline is missing uri", () => {
      const env = baseEnv();
      env.AGORA_BUNDLE_REFS_JSON = JSON.stringify({
        subagent: { uri: "s3://b/sub", contentHash: "sha256:aaa" },
        capabilities: [],
        env: [],
        pipeline: { contentHash: "sha256:pp" },
      });
      expect(() => parseWorkerEnv(env)).toThrow(/AGORA_BUNDLE_REFS_JSON.*pipeline/);
    });

    it("throws when pipeline is missing contentHash", () => {
      const env = baseEnv();
      env.AGORA_BUNDLE_REFS_JSON = JSON.stringify({
        subagent: { uri: "s3://b/sub", contentHash: "sha256:aaa" },
        capabilities: [],
        env: [],
        pipeline: { uri: "agora://ns/pipeline/p/sha256:pp" },
      });
      expect(() => parseWorkerEnv(env)).toThrow(/AGORA_BUNDLE_REFS_JSON.*pipeline/);
    });

    it("throws when pipeline uri is not a string", () => {
      const env = baseEnv();
      env.AGORA_BUNDLE_REFS_JSON = JSON.stringify({
        subagent: { uri: "s3://b/sub", contentHash: "sha256:aaa" },
        capabilities: [],
        env: [],
        pipeline: { uri: 42, contentHash: "sha256:pp" },
      });
      expect(() => parseWorkerEnv(env)).toThrow(/AGORA_BUNDLE_REFS_JSON.*pipeline/);
    });

    it("throws when pipeline contentHash is not a string", () => {
      const env = baseEnv();
      env.AGORA_BUNDLE_REFS_JSON = JSON.stringify({
        subagent: { uri: "s3://b/sub", contentHash: "sha256:aaa" },
        capabilities: [],
        env: [],
        pipeline: { uri: "agora://ns/pipeline/p/sha256:pp", contentHash: 123 },
      });
      expect(() => parseWorkerEnv(env)).toThrow(/AGORA_BUNDLE_REFS_JSON.*pipeline/);
    });
  });

  describe("bundle refs inputs", () => {
    it("parses bundleRefs.inputs when present", () => {
      const env = baseEnv();
      env.AGORA_BUNDLE_REFS_JSON = JSON.stringify({
        subagent: { uri: "s3://b/sub", contentHash: "sha256:aaa" },
        capabilities: [],
        env: [],
        inputs: [{ key: "patch", uri: "agora://ns/artifact/d/sha256:bb", contentHash: "sha256:bb" }],
      });
      expect(parseWorkerEnv(env).bundleRefs.inputs).toEqual([
        { key: "patch", uri: "agora://ns/artifact/d/sha256:bb", contentHash: "sha256:bb" },
      ]);
    });

    it("tolerates absent inputs (old clients)", () => {
      const cfg = parseWorkerEnv(baseEnv());
      expect(cfg.bundleRefs.inputs).toBeUndefined();
    });

    it("throws when inputs is not an array", () => {
      const env = baseEnv();
      env.AGORA_BUNDLE_REFS_JSON = JSON.stringify({
        subagent: { uri: "s3://b/sub", contentHash: "sha256:aaa" },
        capabilities: [],
        env: [],
        inputs: "not-an-array",
      });
      expect(() => parseWorkerEnv(env)).toThrow(/AGORA_BUNDLE_REFS_JSON.*inputs/);
    });

    it("throws when inputs entry is missing key", () => {
      const env = baseEnv();
      env.AGORA_BUNDLE_REFS_JSON = JSON.stringify({
        subagent: { uri: "s3://b/sub", contentHash: "sha256:aaa" },
        capabilities: [],
        env: [],
        inputs: [{ uri: "agora://ns/artifact/d/sha256:bb", contentHash: "sha256:bb" }],
      });
      expect(() => parseWorkerEnv(env)).toThrow(/AGORA_BUNDLE_REFS_JSON.*inputs/);
    });

    it("throws when inputs entry is missing uri", () => {
      const env = baseEnv();
      env.AGORA_BUNDLE_REFS_JSON = JSON.stringify({
        subagent: { uri: "s3://b/sub", contentHash: "sha256:aaa" },
        capabilities: [],
        env: [],
        inputs: [{ key: "patch", contentHash: "sha256:bb" }],
      });
      expect(() => parseWorkerEnv(env)).toThrow(/AGORA_BUNDLE_REFS_JSON.*inputs/);
    });

    it("throws when inputs entry is missing contentHash", () => {
      const env = baseEnv();
      env.AGORA_BUNDLE_REFS_JSON = JSON.stringify({
        subagent: { uri: "s3://b/sub", contentHash: "sha256:aaa" },
        capabilities: [],
        env: [],
        inputs: [{ key: "patch", uri: "agora://ns/artifact/d/sha256:bb" }],
      });
      expect(() => parseWorkerEnv(env)).toThrow(/AGORA_BUNDLE_REFS_JSON.*inputs/);
    });

    it("throws when inputs entry fields are not strings", () => {
      const env = baseEnv();
      env.AGORA_BUNDLE_REFS_JSON = JSON.stringify({
        subagent: { uri: "s3://b/sub", contentHash: "sha256:aaa" },
        capabilities: [],
        env: [],
        inputs: [{ key: 123, uri: "agora://ns/artifact/d/sha256:bb", contentHash: "sha256:bb" }],
      });
      expect(() => parseWorkerEnv(env)).toThrow(/AGORA_BUNDLE_REFS_JSON.*inputs/);
    });

    it("supports multiple inputs entries", () => {
      const env = baseEnv();
      env.AGORA_BUNDLE_REFS_JSON = JSON.stringify({
        subagent: { uri: "s3://b/sub", contentHash: "sha256:aaa" },
        capabilities: [],
        env: [],
        inputs: [
          { key: "patch", uri: "agora://ns/artifact/d/sha256:bb", contentHash: "sha256:bb" },
          { key: "config", uri: "agora://ns/artifact/d/sha256:cc", contentHash: "sha256:cc" },
        ],
      });
      expect(parseWorkerEnv(env).bundleRefs.inputs).toHaveLength(2);
      expect(parseWorkerEnv(env).bundleRefs.inputs?.[1]?.key).toBe("config");
    });
  });
});
