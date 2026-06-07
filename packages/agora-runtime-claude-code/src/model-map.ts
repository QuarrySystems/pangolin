/** Reserved portable levels (spec §2). A second adapter brings its own map. */
const LEVEL_MAP: Record<string, string> = {
  fast: 'haiku',
  standard: 'sonnet',
  max: 'opus',
};

/** Resolve the requested model string to the value passed to `--model`.
 *  Levels map to claude CLI bare aliases (version-free); anything else passes through verbatim. */
export function resolveModelArg(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return LEVEL_MAP[model] ?? model;
}
