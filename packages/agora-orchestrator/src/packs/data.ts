import { z } from "zod";
import type { SubagentShape } from "../contracts/subagent-shape.js";
import { PackRegistry } from "./registry.js";

const WORKER_IMAGE = "sha256:PLACEHOLDER"; // TODO(PR6): pin the real worker image digest before data shapes are dispatched

export const dataSplit: SubagentShape = {
  id: "data.split",
  effectTier: "pure",
  inputSchema: z.object({ dataset: z.string() }),
  outputSchema: z.object({ chunks: z.array(z.string()) }),
  capability: {
    imageDigest: WORKER_IMAGE,
    permissions: {},
    contextShape: "dataset at inputs/dataset",
  },
  outputEdgeType: "dataset-ref",
  inputEdgeTypes: { dataset: "dataset-ref" },
};

export const dataTransform: SubagentShape = {
  id: "data.transform",
  effectTier: "pure",
  inputSchema: z.object({ input: z.string() }),
  outputSchema: z.object({ output: z.string() }),
  capability: {
    imageDigest: WORKER_IMAGE,
    permissions: {},
    contextShape: "dataset at inputs/input",
  },
  outputEdgeType: "dataset-ref",
  inputEdgeTypes: { input: "dataset-ref" },
};

export const dataAggregate: SubagentShape = {
  id: "data.aggregate",
  effectTier: "pure",
  inputSchema: z.record(z.string()),
  outputSchema: z.object({ result: z.string() }),
  capability: {
    imageDigest: WORKER_IMAGE,
    permissions: {},
    contextShape: "dataset parts at inputs/",
  },
  outputEdgeType: "dataset-ref",
  // inputEdgeTypes deliberately OMITTED:
  // reduce needs-keys are dynamic ('<prefix>-<key>'), and validateRun's tag check is
  // permissive per-key — dynamic keys simply aren't tag-checked. Explicit note > silent magic.
};

export const dataPack: SubagentShape[] = [dataSplit, dataTransform, dataAggregate];
export const dataRegistry = (): PackRegistry => new PackRegistry(dataPack);
