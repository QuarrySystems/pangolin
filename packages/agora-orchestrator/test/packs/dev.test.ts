import { it, expect } from "vitest";
import { devPack, devCodeEdit, devVerify } from "../../src/packs/dev.js";
import { PackRegistry } from "../../src/packs/registry.js";

it("dev shapes declare correct effect tiers", () => {
  expect(devCodeEdit.effectTier).toBe("write-impure");
  expect(devVerify.effectTier).toBe("read-impure");
});

it("dev shapes register without collision and schema round-trips are correct", () => {
  const r = new PackRegistry(devPack);

  // dev.code-edit — valid case
  expect(
    r.get("dev.code-edit")?.inputSchema.safeParse({ baseCommit: "a", instructions: "do x" }).success
  ).toBe(true);

  // dev.code-edit — invalid: wrong type AND missing field (original case kept)
  expect(
    r.get("dev.code-edit")?.inputSchema.safeParse({ baseCommit: 1 }).success
  ).toBe(false);

  // dev.code-edit — invalid: structurally complete but instructions is wrong type (isolates one constraint)
  expect(
    r.get("dev.code-edit")?.inputSchema.safeParse({ baseCommit: "a", instructions: 42 }).success
  ).toBe(false);

  // dev.verify — valid case
  expect(
    r.get("dev.verify")?.inputSchema.safeParse({ patch: { baseCommit: "a", diff: "--- a\n+++ b\n" } }).success
  ).toBe(true);

  // dev.verify — invalid: bare string instead of object with patch
  expect(
    r.get("dev.verify")?.inputSchema.safeParse("not-an-object").success
  ).toBe(false);

  // dev.verify — invalid: patch field is a string instead of a patchSchema object
  expect(
    r.get("dev.verify")?.inputSchema.safeParse({ patch: "x" }).success
  ).toBe(false);
});
