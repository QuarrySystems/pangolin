import { it, expect } from "vitest";
import { effectTierPolicy } from "../src/contracts/effect-policy.js";

it("classifies each tier", () => {
  expect(effectTierPolicy("pure").cacheable).toBe(true);
  expect(effectTierPolicy("read-impure").needsSnapshot).toBe(true);
  expect(effectTierPolicy("write-impure").gated).toBe(true);
});
