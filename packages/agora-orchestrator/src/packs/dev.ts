import { z } from "zod";
import { patchSchema, intentSchema } from "../contracts/core-types.js";
import type { SubagentShape } from "../contracts/subagent-shape.js";
import { PackRegistry } from "./registry.js";

const WORKER_IMAGE = "sha256:PLACEHOLDER"; // TODO(PR6): pin the real worker image digest before dev shapes are dispatched

export const devCodeEdit: SubagentShape = {
  id: "dev.code-edit",
  effectTier: "write-impure",
  inputSchema: z.object({ baseCommit: z.string(), instructions: z.string() }),
  outputSchema: z.object({ patch: patchSchema, intents: z.array(intentSchema).optional() }),
  capability: { imageDigest: WORKER_IMAGE, permissions: {}, contextShape: "repo worktree at baseCommit" },
  outputEdgeType: "patch-ref",
};

export const devVerify: SubagentShape = {
  id: "dev.verify",
  effectTier: "read-impure",
  inputSchema: z.object({ patch: patchSchema }),
  outputSchema: z.object({ passed: z.boolean(), report: z.string() }),
  capability: { imageDigest: WORKER_IMAGE, permissions: {}, contextShape: "repo snapshot + patch applied" },
  inputEdgeTypes: { patch: "patch-ref" },
};

export const devPack: SubagentShape[] = [devCodeEdit, devVerify];
export const devRegistry = (): PackRegistry => new PackRegistry(devPack);
