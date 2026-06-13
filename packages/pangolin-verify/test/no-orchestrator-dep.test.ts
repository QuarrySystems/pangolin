import { it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

it('pangolin-verify never imports from pangolin-orchestrator', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, '..', 'src');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    expect(src, `${f} must not import orchestrator`).not.toMatch(/pangolin-orchestrator/);
  }
});
