// Offline smoke test — no Docker, no MinIO, no API key.
// Proves that plan.json has the correct shape for the minio-proof run:
//   4 real code-edit items split across two executors,
//   two items contending on shared.ts, plus a verify gate.

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

it('4 real edits, routed across two executors, two contend on shared.ts, verify gates all', async () => {
  const plan = JSON.parse(await readFile(fileURLToPath(new URL('../plan.json', import.meta.url)), 'utf8'));
  const edits = plan.items.filter((i: any) => i.id.startsWith('edit-'));
  expect(edits).toHaveLength(4);
  expect(edits.every((e: any) => e.inputs.subagent === 'code-edit')).toBe(true); // all REAL
  expect(edits.every((e: any) => typeof e.inputs.workerInput?.file === 'string')).toBe(true);
  expect(new Set(edits.map((e: any) => e.executor))).toEqual(new Set(['dispatch-a','dispatch-b']));
  const shared = edits.filter((e: any) => e.resourceLocks.includes('shared.ts'));
  expect(shared).toHaveLength(2);
  const verify = plan.items.find((i: any) => i.id === 'verify');
  expect(verify.depends_on).toEqual(expect.arrayContaining(edits.map((e: any) => e.id)));
});
