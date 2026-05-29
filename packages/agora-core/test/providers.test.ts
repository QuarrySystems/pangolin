import { it, expect } from 'vitest';
import type { SecretStore } from "../src/providers.js";

it("permits a SecretStore with an optional dir", () => {
  const s: SecretStore = {
    name: "x", dir: "/tmp/secrets",
    stage: async () => ({ ref: "r", ttlSeconds: 1 }),
    resolve: async () => "v", cleanupByTag: async () => {},
  };
  expect(s.dir).toBe("/tmp/secrets");
  const noDir: SecretStore = { name: "y", stage: s.stage, resolve: s.resolve, cleanupByTag: s.cleanupByTag };
  expect(noDir.dir).toBeUndefined();
});
