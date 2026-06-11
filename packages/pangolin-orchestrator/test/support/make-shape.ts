import { z } from "zod";
import type { SubagentShape } from "../../src/contracts/subagent-shape.js";

export function makeShape(over: Partial<SubagentShape> = {}): SubagentShape {
  return {
    id: "dev.x",
    effectTier: "pure",
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    capability: { imageDigest: "sha256:1", permissions: {}, contextShape: "" },
    ...over,
  };
}
