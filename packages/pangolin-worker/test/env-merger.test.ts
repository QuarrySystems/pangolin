import { describe, it, expect } from "vitest";
import { mergeEnv } from "../src/env-merger.js";

describe("mergeEnv", () => {
  it("per-dispatch secrets win over env-bundle secrets on key conflict", () => {
    const merged = mergeEnv({
      envBundles: [{ values: {}, secrets: { K: "env-secret" } }],
      perDispatchSecrets: { K: "dispatch-secret" },
      baseEnv: {},
    });
    expect(merged.K).toBe("dispatch-secret");
  });

  it("later env bundles win over earlier ones", () => {
    const merged = mergeEnv({
      envBundles: [
        { values: { K: "first" }, secrets: {} },
        { values: { K: "second" }, secrets: {} },
      ],
      perDispatchSecrets: {},
      baseEnv: {},
    });
    expect(merged.K).toBe("second");
  });

  it("includes baseEnv values", () => {
    const merged = mergeEnv({
      envBundles: [],
      perDispatchSecrets: {},
      baseEnv: { BASE_VAR: "base-value" },
    });
    expect(merged.BASE_VAR).toBe("base-value");
  });

  it("merges env-bundle values and secrets together", () => {
    const merged = mergeEnv({
      envBundles: [{ values: { VAL: "value" }, secrets: { SEC: "secret" } }],
      perDispatchSecrets: {},
      baseEnv: {},
    });
    expect(merged.VAL).toBe("value");
    expect(merged.SEC).toBe("secret");
  });

  it("merges multiple env bundles in order, later-wins", () => {
    const merged = mergeEnv({
      envBundles: [
        { values: { A: "a1", B: "b1" }, secrets: { C: "c1" } },
        { values: { B: "b2" }, secrets: { D: "d2" } },
        { values: { A: "a3" }, secrets: { C: "c3" } },
      ],
      perDispatchSecrets: {},
      baseEnv: {},
    });
    expect(merged.A).toBe("a3"); // last one wins
    expect(merged.B).toBe("b2"); // second bundle wins
    expect(merged.C).toBe("c3"); // last one wins
    expect(merged.D).toBe("d2"); // only in second bundle
  });

  it("per-dispatch secrets win over everything", () => {
    const merged = mergeEnv({
      envBundles: [
        { values: { X: "bundle-val" }, secrets: { X: "bundle-sec" } },
      ],
      perDispatchSecrets: { X: "dispatch-val" },
      baseEnv: { X: "base-val" },
    });
    expect(merged.X).toBe("dispatch-val");
  });

  it("handles empty inputs gracefully", () => {
    const merged = mergeEnv({
      envBundles: [],
      perDispatchSecrets: {},
      baseEnv: {},
    });
    expect(merged).toEqual({});
  });

  it("preserves baseEnv values not overridden", () => {
    const merged = mergeEnv({
      envBundles: [{ values: { NEW: "new" }, secrets: {} }],
      perDispatchSecrets: {},
      baseEnv: { EXISTING: "exists", PANGOLIN_ROOT: "/root" },
    });
    expect(merged.EXISTING).toBe("exists");
    expect(merged.PANGOLIN_ROOT).toBe("/root");
    expect(merged.NEW).toBe("new");
  });
});
