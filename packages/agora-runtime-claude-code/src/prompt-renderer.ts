// Renders a RuntimeInvocation to a final prompt string (§5.8).
//
// If `promptTemplate` is set, applies Mustache substitution with `input`
// variables; otherwise returns `systemPrompt` verbatim. Mustache's default
// HTML escaping is disabled — prompts are LLM text, not HTML.
//
// CAUTION: setting `Mustache.escape` mutates module-global behavior. The
// runtime-cc adapter is currently the sole consumer of Mustache in this
// package, so the global mutation is acceptable for MVP. If a second
// consumer appears, switch to a save-and-restore pattern around the
// render call (or use a fresh Mustache instance per render).

import Mustache from "mustache";
import type { RuntimeInvocation } from "@quarry-systems/agora-core";

// Disable HTML escaping once at module load. Re-asserting on every call
// would be wasteful and would still race if a second consumer existed.
Mustache.escape = (s: string): string => s;

export function renderPrompt(spec: RuntimeInvocation): string {
  if (spec.promptTemplate !== undefined) {
    return Mustache.render(spec.promptTemplate, spec.input ?? {});
  }
  if (spec.systemPrompt !== undefined) {
    return spec.systemPrompt;
  }
  throw new Error(
    "renderPrompt: at least one of systemPrompt or promptTemplate is required",
  );
}
