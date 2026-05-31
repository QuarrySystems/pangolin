import { it, expect } from "vitest";
import { PackRegistry } from "../../src/packs/registry.js";
import { makeShape } from "../support/make-shape.js";

it("rejects duplicate ids at construction", () => {
  expect(() => new PackRegistry([makeShape({ id: "dev.a" }), makeShape({ id: "dev.a" })])).toThrow(/duplicate shape id dev\.a/);
});

it("resolves a registered shape by id", () => {
  const r = new PackRegistry([makeShape({ id: "dev.a" })]);
  expect(r.get("dev.a")?.id).toBe("dev.a");
  expect(r.has("dev.b")).toBe(false);
  expect(r.get("dev.b")).toBeUndefined();
});
