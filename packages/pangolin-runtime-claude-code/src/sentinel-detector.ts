import { access } from 'node:fs/promises';
import { join } from 'node:path';

export async function detectNeedsInputSentinel(workspaceDir: string): Promise<string | undefined> {
  const path = join(workspaceDir, '.pangolin', 'needs_input.json');
  try { await access(path); return path; } catch { return undefined; }
}
