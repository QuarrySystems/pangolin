import { describe, it, expect } from "vitest";
import { patchSchema, intentSchema, type Patch } from "../src/contracts/core-types.js";

describe("core-types schemas", () => {
  it("patchSchema accepts valid input and rejects malformed input", () => {
    const p: Patch = { baseCommit: "abc123", diff: "--- a\n+++ b\n" };
    expect(patchSchema.safeParse(p).success).toBe(true);
    expect(patchSchema.safeParse({ baseCommit: 1, diff: "x" }).success).toBe(false);
  });

  it("intentSchema accepts valid input and rejects malformed input", () => {
    expect(intentSchema.safeParse({ kind: "open-pr", payload: {} }).success).toBe(true);
    expect(intentSchema.safeParse({ kind: 1, payload: {} }).success).toBe(false);
  });
});
