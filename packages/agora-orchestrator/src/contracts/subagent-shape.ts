import { z } from "zod";
import { isPackScopedId } from "@quarry-systems/agora-core";
import type { EffectTier } from "./types.js";

export interface Capability {
  imageDigest: string;                     // pinned container image
  permissions: Record<string, unknown>;    // capability-scoped policy
  contextShape: string;                    // declarative description of staged context
}

export interface SubagentShape {
  id: string;                              // "<pack>.<name>", e.g. "dev.code-edit"
  effectTier: EffectTier;
  inputSchema: z.ZodType<unknown>;
  outputSchema: z.ZodType<unknown>;        // declared now; enforced via .agora/output.json in PR6
  capability: Capability;
  /** Edge-type tag of this shape's primary product (e.g. 'patch-ref'). Optional;
   *  when both ends of a needs edge declare tags, validateRun requires a match. */
  outputEdgeType?: string;
  /** Expected edge-type tag per typed input key (e.g. { patch: 'patch-ref' }). */
  inputEdgeTypes?: Record<string, string>;
}

/** Throws on a malformed shape. Used at registry construction (D8). */
export function validateShape(s: SubagentShape): void {
  if (!isPackScopedId(s.id))
    throw new Error(`SubagentShape: id "${s.id}" must be "<pack>.<name>"`);
  if (!["pure", "read-impure", "write-impure"].includes(s.effectTier))
    throw new Error(`SubagentShape ${s.id}: invalid effectTier ${s.effectTier}`);
  if (!s.capability?.imageDigest)
    throw new Error(`SubagentShape ${s.id}: capability.imageDigest required`);
  if (s.outputEdgeType !== undefined && s.outputEdgeType === "")
    throw new Error(`SubagentShape ${s.id}: outputEdgeType must be a non-empty string`);
  if (s.inputEdgeTypes !== undefined) {
    for (const [key, val] of Object.entries(s.inputEdgeTypes)) {
      if (val === "")
        throw new Error(`SubagentShape ${s.id}: inputEdgeTypes["${key}"] must be a non-empty string`);
    }
  }
}
