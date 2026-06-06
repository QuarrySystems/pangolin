import { it, expect } from "vitest";
import { dataPack, dataRegistry, dataSplit, dataTransform, dataAggregate } from "../../src/packs/data.js";
import { devPack, devCodeEdit } from "../../src/packs/dev.js";
import { PackRegistry } from "../../src/packs/registry.js";
import { validateRun, normalizeRun } from "../../src/engine/run-validator.js";

// ---- Shape field tests ----

it("data.split effectTier is 'pure'", () => {
  expect(dataSplit.effectTier).toBe("pure");
});

it("data.split outputEdgeType is 'dataset-ref'", () => {
  expect(dataSplit.outputEdgeType).toBe("dataset-ref");
});

it("data.split inputEdgeTypes maps dataset to 'dataset-ref'", () => {
  expect(dataSplit.inputEdgeTypes).toEqual({ dataset: "dataset-ref" });
});

it("data.transform inputEdgeTypes maps input to 'dataset-ref'", () => {
  expect(dataTransform.inputEdgeTypes).toEqual({ input: "dataset-ref" });
});

it("data.transform outputEdgeType is 'dataset-ref'", () => {
  expect(dataTransform.outputEdgeType).toBe("dataset-ref");
});

it("data.aggregate outputEdgeType is 'dataset-ref'", () => {
  expect(dataAggregate.outputEdgeType).toBe("dataset-ref");
});

it("data.aggregate has no inputEdgeTypes (dynamic reduce keys)", () => {
  // Intentionally omitted: reduce needs-keys are dynamic ('<prefix>-<key>'),
  // and validateRun's tag check is permissive per-key — dynamic keys aren't tag-checked.
  expect(dataAggregate.inputEdgeTypes).toBeUndefined();
});

// ---- Pack registration tests ----

it("three data shapes register without collision", () => {
  expect(() => new PackRegistry(dataPack)).not.toThrow();
});

it("dataPack contains all three shapes", () => {
  expect(dataPack).toHaveLength(3);
  const ids = dataPack.map((s) => s.id);
  expect(ids).toContain("data.split");
  expect(ids).toContain("data.transform");
  expect(ids).toContain("data.aggregate");
});

it("dataRegistry resolves all three data shapes", () => {
  expect(dataRegistry().get("data.split")?.id).toBe("data.split");
  expect(dataRegistry().get("data.transform")?.id).toBe("data.transform");
  expect(dataRegistry().get("data.aggregate")?.id).toBe("data.aggregate");
});

it("combined devPack + dataPack registers without collision (ids unique across packs)", () => {
  expect(() => new PackRegistry([...devPack, ...dataPack])).not.toThrow();
});

// ---- Schema round-trip tests ----

it("data.split inputSchema accepts a dataset object", () => {
  expect(
    dataSplit.inputSchema.safeParse({ dataset: "s3://bucket/path/file.csv" }).success
  ).toBe(true);
});

it("data.transform inputSchema accepts an input reference", () => {
  expect(
    dataTransform.inputSchema.safeParse({ input: "s3://bucket/splits/0.csv" }).success
  ).toBe(true);
});

it("data.aggregate inputSchema accepts arbitrary keys (permissive)", () => {
  expect(
    dataAggregate.inputSchema.safeParse({ "part-0": "s3://bucket/splits/0.parquet", "part-1": "s3://bucket/splits/1.parquet" }).success
  ).toBe(true);
});

// ---- Cross-pack validateRun tests ----

it("data.split -> data.transform edge is accepted by validateRun (dataset-ref both ends)", () => {
  const run = normalizeRun({
    id: "test-run",
    items: [
      {
        id: "split-1",
        subagentShape: "data.split",
        depends_on: [],
        needs: {},
        status: "pending",
        attempts: [],
      },
      {
        id: "transform-1",
        subagentShape: "data.transform",
        depends_on: ["split-1"],
        needs: { input: { from: "split-1", select: "dataset" } },
        status: "pending",
        attempts: [],
      },
    ],
  });

  const combinedRegistry = new PackRegistry([...devPack, ...dataPack]);
  const errors = validateRun(run, combinedRegistry);
  expect(errors).toHaveLength(0);
});

it("a dev->data needs edge fails validateRun tag-matching (patch-ref vs dataset-ref)", () => {
  // dev.code-edit outputs patch-ref; data.transform expects dataset-ref on input key
  const run = normalizeRun({
    id: "test-run",
    items: [
      {
        id: "code-edit-1",
        subagentShape: "dev.code-edit",
        depends_on: [],
        needs: {},
        status: "pending",
        attempts: [],
      },
      {
        id: "transform-1",
        subagentShape: "data.transform",
        depends_on: ["code-edit-1"],
        needs: { input: { from: "code-edit-1", select: "patch" } },
        status: "pending",
        attempts: [],
      },
    ],
  });

  const combinedRegistry = new PackRegistry([...devPack, ...dataPack]);
  const errors = validateRun(run, combinedRegistry);
  expect(errors.length).toBeGreaterThan(0);
  expect(errors[0]).toMatch(/patch-ref->dataset-ref incompatible; needs an adapter block/);
});
