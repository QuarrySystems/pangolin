import type { EffectTier } from "./types.js";

export interface EffectPolicy {
  cacheable: boolean;       // pure work is replayable/cacheable
  needsSnapshot: boolean;   // read-impure: snapshot live state pre-dispatch
  gated: boolean;           // write-impure: intent must pass interpreter policy
}

export function effectTierPolicy(tier: EffectTier): EffectPolicy {
  switch (tier) {
    case "pure":         return { cacheable: true,  needsSnapshot: false, gated: false };
    case "read-impure":  return { cacheable: false, needsSnapshot: true,  gated: false };
    case "write-impure": return { cacheable: false, needsSnapshot: false, gated: true  };
  }
}
