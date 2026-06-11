import { describe, it, expect } from "vitest";
import { applyMergeRule, MergeTypeConflictError } from "../src/merge-rules.js";

describe("applyMergeRule", () => {
  describe("last-write-wins", () => {
    it("returns incoming for primitives", () => {
      expect(applyMergeRule({ strategy: "last-write-wins" }, 1, 2)).toBe(2);
    });

    it("returns incoming for objects (no merging)", () => {
      const existing = { a: 1, b: 2 };
      const incoming = { b: 99 };
      expect(applyMergeRule({ strategy: "last-write-wins" }, existing, incoming)).toEqual({ b: 99 });
    });

    it("returns incoming even when undefined", () => {
      expect(applyMergeRule({ strategy: "last-write-wins" }, { a: 1 }, undefined)).toBeUndefined();
    });
  });

  describe("array-union", () => {
    it("deduplicates while preserving first-seen order", () => {
      const result = applyMergeRule({ strategy: "array-union" }, [1, 2, 3], [3, 2, 4, 5]);
      expect(result).toEqual([1, 2, 3, 4, 5]);
    });

    it("returns empty array when both are empty", () => {
      expect(applyMergeRule({ strategy: "array-union" }, [], [])).toEqual([]);
    });

    it("does not mutate inputs", () => {
      const existing = [1, 2];
      const incoming = [3, 4];
      applyMergeRule({ strategy: "array-union" }, existing, incoming);
      expect(existing).toEqual([1, 2]);
      expect(incoming).toEqual([3, 4]);
    });

    it("throws MergeTypeConflictError when existing is not an array", () => {
      expect(() => applyMergeRule({ strategy: "array-union" }, "nope", [1])).toThrow(
        MergeTypeConflictError,
      );
    });

    it("throws MergeTypeConflictError when incoming is not an array", () => {
      expect(() => applyMergeRule({ strategy: "array-union" }, [1], { not: "array" })).toThrow(
        MergeTypeConflictError,
      );
    });
  });

  describe("deep-merge", () => {
    it("recursively merges nested objects", () => {
      const existing = { a: { b: 1, c: 2 }, d: 3 };
      const incoming = { a: { c: 99, e: 4 } };
      const result = applyMergeRule({ strategy: "deep-merge" }, existing, incoming);
      expect(result).toEqual({ a: { b: 1, c: 99, e: 4 }, d: 3 });
    });

    it("takes incoming for scalar leaves (last-write-wins per leaf)", () => {
      const result = applyMergeRule({ strategy: "deep-merge" }, { a: 1 }, { a: 2 });
      expect(result).toEqual({ a: 2 });
    });

    it("with arrayMode 'union' dedupes arrays", () => {
      const result = applyMergeRule(
        { strategy: "deep-merge", arrayMode: "union" },
        { a: [1, 2] },
        { a: [2, 3] },
      );
      expect((result as { a: number[] }).a).toEqual([1, 2, 3]);
    });

    it("defaults arrayMode to 'union' when omitted", () => {
      const result = applyMergeRule(
        { strategy: "deep-merge" },
        { a: [1, 2] },
        { a: [2, 3] },
      );
      expect((result as { a: number[] }).a).toEqual([1, 2, 3]);
    });

    it("with arrayMode 'replace' returns incoming array", () => {
      const result = applyMergeRule(
        { strategy: "deep-merge", arrayMode: "replace" },
        { a: [1, 2, 3] },
        { a: [9] },
      );
      expect((result as { a: number[] }).a).toEqual([9]);
    });

    it("with arrayMode 'concat' appends without dedup", () => {
      const result = applyMergeRule(
        { strategy: "deep-merge", arrayMode: "concat" },
        { a: [1, 2] },
        { a: [2, 3] },
      );
      expect((result as { a: number[] }).a).toEqual([1, 2, 2, 3]);
    });

    it("uses incoming when existing key is undefined", () => {
      const result = applyMergeRule({ strategy: "deep-merge" }, {}, { a: 1 });
      expect(result).toEqual({ a: 1 });
    });

    it("uses existing when incoming value is undefined", () => {
      const result = applyMergeRule(
        { strategy: "deep-merge" },
        { a: 1, b: 2 },
        { a: undefined },
      );
      expect((result as { a: number; b: number }).a).toBe(1);
    });

    it("throws MergeTypeConflictError when object meets scalar", () => {
      expect(() =>
        applyMergeRule({ strategy: "deep-merge" }, { a: { b: 1 } }, { a: "string" }),
      ).toThrow(MergeTypeConflictError);
    });

    it("throws MergeTypeConflictError when array meets object", () => {
      expect(() =>
        applyMergeRule({ strategy: "deep-merge" }, { a: [1] }, { a: { b: 1 } }),
      ).toThrow(MergeTypeConflictError);
    });

    it("includes path in error for nested conflicts", () => {
      try {
        applyMergeRule(
          { strategy: "deep-merge" },
          { outer: { inner: 1 } },
          { outer: { inner: { unexpected: true } } },
          "root",
        );
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(MergeTypeConflictError);
        expect((e as MergeTypeConflictError).path).toBe("root.outer.inner");
        expect((e as MergeTypeConflictError).leftType).toBe("number");
        expect((e as MergeTypeConflictError).rightType).toBe("object");
      }
    });

    it("does not mutate inputs", () => {
      const existing = { a: { b: 1 }, list: [1] };
      const incoming = { a: { c: 2 }, list: [2] };
      applyMergeRule({ strategy: "deep-merge", arrayMode: "concat" }, existing, incoming);
      expect(existing).toEqual({ a: { b: 1 }, list: [1] });
      expect(incoming).toEqual({ a: { c: 2 }, list: [2] });
    });

    it("treats null as a scalar that triggers type conflict against object", () => {
      expect(() =>
        applyMergeRule({ strategy: "deep-merge" }, { a: { b: 1 } }, { a: null }),
      ).toThrow(MergeTypeConflictError);
    });

    it("returns incoming when both leaves are null/null", () => {
      const result = applyMergeRule({ strategy: "deep-merge" }, { a: null }, { a: null });
      expect((result as { a: null }).a).toBeNull();
    });
  });
});

describe("MergeTypeConflictError", () => {
  it("exposes path, leftType, rightType and a descriptive message", () => {
    const err = new MergeTypeConflictError("a.b", "object", "string");
    expect(err.name).toBe("MergeTypeConflictError");
    expect(err.path).toBe("a.b");
    expect(err.leftType).toBe("object");
    expect(err.rightType).toBe("string");
    expect(err.message).toMatch(/a\.b/);
    expect(err.message).toMatch(/object/);
    expect(err.message).toMatch(/string/);
  });
});
