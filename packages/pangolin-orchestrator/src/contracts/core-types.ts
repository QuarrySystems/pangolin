import { z } from "zod";

/** A unified diff against a declared base commit hash. */
export const patchSchema = z.object({
  baseCommit: z.string(),   // commit hash the diff applies against
  diff: z.string(),         // unified-diff text
});
export type Patch = z.infer<typeof patchSchema>;

/** A structured proposal for a side effect; realized later by an IntentInterpreter (write-impure). */
export const intentSchema = z.object({
  kind: z.string(),                 // e.g. "open-pr", "post-comment"
  payload: z.record(z.unknown()),
});
export type Intent = z.infer<typeof intentSchema>;
