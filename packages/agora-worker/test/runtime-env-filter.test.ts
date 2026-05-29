import { describe, it, expect } from "vitest";
import { filterRuntimeEnv } from "../src/runtime-env-filter.js";

describe("filterRuntimeEnv", () => {
  it("strips the Agora control-plane HMAC key reference", () => {
    const out = filterRuntimeEnv({
      AGORA_CALLBACK_TOKEN_REF: "arn:aws:secretsmanager:...:secret:hmac",
      PATH: "/usr/bin",
    });
    expect(out).not.toHaveProperty("AGORA_CALLBACK_TOKEN_REF");
    expect(out.PATH).toBe("/usr/bin");
  });

  it("strips every AGORA_* control-plane variable by prefix", () => {
    const out = filterRuntimeEnv({
      AGORA_DISPATCH_ID: "d-1",
      AGORA_BUNDLE_REFS_JSON: "{}",
      AGORA_STORAGE_URI: "s3://bucket/prefix",
      AGORA_ANYTHING_FUTURE: "x",
      LOG_LEVEL: "info",
    });
    expect(Object.keys(out).filter((k) => k.startsWith("AGORA_"))).toEqual([]);
    expect(out.LOG_LEVEL).toBe("info");
  });

  it("strips ambient AWS task-role credential-vending variables", () => {
    const out = filterRuntimeEnv({
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "token",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/abc",
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.2/creds",
      AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/secrets/token",
      AWS_ROLE_ARN: "arn:aws:iam::123:role/worker",
    });
    expect(Object.keys(out)).toEqual([]);
  });

  it("preserves AWS_REGION and AWS_DEFAULT_REGION (not credentials)", () => {
    const out = filterRuntimeEnv({
      AWS_REGION: "us-east-1",
      AWS_DEFAULT_REGION: "us-east-1",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
    expect(out.AWS_REGION).toBe("us-east-1");
    expect(out.AWS_DEFAULT_REGION).toBe("us-east-1");
    expect(out).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });

  it("preserves arbitrary user/system variables", () => {
    const out = filterRuntimeEnv({
      PATH: "/usr/bin",
      HOME: "/root",
      LANG: "C.UTF-8",
      MY_APP_FLAG: "true",
    });
    expect(out).toEqual({
      PATH: "/usr/bin",
      HOME: "/root",
      LANG: "C.UTF-8",
      MY_APP_FLAG: "true",
    });
  });

  it("strips additional keys passed via opts.deny", () => {
    const out = filterRuntimeEnv(
      { KEEP: "1", DROP_ME: "2" },
      { deny: ["DROP_ME"] },
    );
    expect(out).toEqual({ KEEP: "1" });
  });

  it("does not mutate the input object", () => {
    const input = { AGORA_DISPATCH_ID: "d-1", PATH: "/usr/bin" };
    filterRuntimeEnv(input);
    expect(input).toEqual({ AGORA_DISPATCH_ID: "d-1", PATH: "/usr/bin" });
  });
});
