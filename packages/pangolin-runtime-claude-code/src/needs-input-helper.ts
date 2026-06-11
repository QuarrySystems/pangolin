// Authors the `pangolin-needs-input-helper` SKILL.md content per §6.9 + §6.6 and
// exposes a helper returning the asset as a capability-bundle-shaped overlay.
// The adapter prepends this overlay to integrator capabilities before runtime
// spawn — suppressible via `PANGOLIN_DISABLE_NEEDS_INPUT_HELPER=true`.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SKILL_OVERLAY_PATH = '.claude/skills/pangolin-needs-input/SKILL.md';

// Package is built as CommonJS (no `"type": "module"` in package.json), so
// `__dirname` is the built-in CJS module-scoped value. At dev time (vitest /
// tsx) the source file lives at `src/needs-input-helper.ts`, so the asset is
// resolved relative to that. After `tsc` build the compiled `.js` lives at
// `dist/needs-input-helper.js`, and the `build` script in package.json copies
// `src/assets/` to `dist/assets/` so this same resolution works for the
// published package.
export async function getNeedsInputHelperOverlay(): Promise<
  Record<string, Uint8Array>
> {
  const skillPath = join(__dirname, 'assets', 'needs-input-helper-skill.md');
  const bytes = await readFile(skillPath);
  return { [SKILL_OVERLAY_PATH]: bytes };
}

export function isHelperDisabled(env: Record<string, string>): boolean {
  return env.PANGOLIN_DISABLE_NEEDS_INPUT_HELPER === 'true';
}
