import { describe, it, expect } from "vitest";
import { filterRuntimeEnv } from "../src/runtime-env-filter.js";

describe("filterRuntimeEnv (default-deny allow-list)", () => {
  it("passes built-in non-credential vars", () => {
    const out = filterRuntimeEnv({
      PATH: "/usr/bin", HOME: "/home/pangolin", LANG: "C.UTF-8",
      TZ: "UTC", TERM: "xterm", NODE_ENV: "production",
      AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "us-east-1",
    });
    expect(out).toEqual({
      PATH: "/usr/bin", HOME: "/home/pangolin", LANG: "C.UTF-8",
      TZ: "UTC", TERM: "xterm", NODE_ENV: "production",
      AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "us-east-1",
    });
  });
  it("passes LC_* by built-in prefix", () => {
    const out = filterRuntimeEnv({ LC_ALL: "C", LC_CTYPE: "UTF-8" });
    expect(out).toEqual({ LC_ALL: "C", LC_CTYPE: "UTF-8" });
  });
  it("DROPS arbitrary user vars and credentials by default", () => {
    const out = filterRuntimeEnv({
      GITHUB_TOKEN: "ghp_x", MY_APP_FLAG: "true",
      AWS_SECRET_ACCESS_KEY: "secret", AWS_ACCESS_KEY_ID: "AKIA...",
      LOG_LEVEL: "debug",
    });
    expect(out).toEqual({});
  });
  it("DROPS all PANGOLIN_* control-plane vars (not in allow-list)", () => {
    const out = filterRuntimeEnv({
      PANGOLIN_DISPATCH_ID: "d-1",
      PANGOLIN_CALLBACK_TOKEN_REF: "arn:...:hmac",
      PATH: "/usr/bin",
    });
    expect(Object.keys(out).filter((k) => k.startsWith("PANGOLIN_"))).toEqual([]);
    expect(out.PATH).toBe("/usr/bin");
  });
  it("passes operator allow-list exact names", () => {
    const out = filterRuntimeEnv({ MY_APP_FLAG: "true", OTHER: "x" }, { allow: ["MY_APP_FLAG"] });
    expect(out).toEqual({ MY_APP_FLAG: "true" });
  });
  it("passes operator allow-list PREFIX_* trailing-glob", () => {
    const out = filterRuntimeEnv({ MYAPP_FOO: "1", MYAPP_BAR: "2", OTHER: "x" }, { allow: ["MYAPP_*"] });
    expect(out).toEqual({ MYAPP_FOO: "1", MYAPP_BAR: "2" });
  });
  it("ignores empty/whitespace allow entries", () => {
    const out = filterRuntimeEnv({ FOO: "1" }, { allow: ["", "  "] });
    expect(out).toEqual({});
  });
  it("does not mutate the input object", () => {
    const input = { PANGOLIN_DISPATCH_ID: "d-1", PATH: "/usr/bin" };
    filterRuntimeEnv(input);
    expect(input).toEqual({ PANGOLIN_DISPATCH_ID: "d-1", PATH: "/usr/bin" });
  });
});
