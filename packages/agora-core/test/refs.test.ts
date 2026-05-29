import { it, expect } from "vitest";
import type { SecretRef } from "../src/refs.js";

it("SecretRef discriminates on the `ref` field", () => {
  const r: SecretRef = { ref: "arn:aws:secretsmanager:...:secret:x" };
  expect("ref" in r).toBe(true);
  // @ts-expect-error — `arn` is no longer part of the shape
  const _bad: SecretRef = { arn: "x" };
});
