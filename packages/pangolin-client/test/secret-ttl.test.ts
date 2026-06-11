import { it, expect } from "vitest";
import { computeInlineSecretTtl } from "../src/secret-ttl.js";

it("honors explicit 0 and falls back to timeout + 300", () => {
  expect(computeInlineSecretTtl({ explicit: 0 })).toBe(0);
  expect(computeInlineSecretTtl({ dispatchTimeoutSeconds: 100 })).toBe(400);
});
