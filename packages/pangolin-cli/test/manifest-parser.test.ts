import { parseManifest } from '../src/manifest-parser.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, beforeEach, afterEach } from 'vitest';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'manifest-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('parses a valid manifest', async () => {
  const p = join(dir, 'pangolin.config.yaml');
  await writeFile(
    p,
    `
capabilities:
  - name: git-write
    from: ./caps/git-write
subagents:
  - name: code-reviewer
    systemPrompt: review code
envs:
  - name: prod
    values:
      LOG_LEVEL: info
`,
  );
  const m = await parseManifest(p);
  expect(m.capabilities?.[0].name).toBe('git-write');
  expect(m.capabilities?.[0].from).toBe('./caps/git-write');
  expect(m.subagents?.[0].systemPrompt).toBe('review code');
  expect(m.envs?.[0].values?.LOG_LEVEL).toBe('info');
});

it('rejects subagent with neither systemPrompt nor promptTemplate', async () => {
  const p = join(dir, 'bad.yaml');
  await writeFile(p, 'subagents:\n  - name: broken\n');
  await expect(parseManifest(p)).rejects.toThrow(/systemPrompt or promptTemplate/);
});

it('rejects manifest that is not a YAML object', async () => {
  const p = join(dir, 'scalar.yaml');
  await writeFile(p, 'just-a-string\n');
  await expect(parseManifest(p)).rejects.toThrow(/must be a YAML object/);
});

it('rejects capabilities that is not an array', async () => {
  const p = join(dir, 'bad-caps.yaml');
  await writeFile(p, 'capabilities:\n  name: oops\n');
  await expect(parseManifest(p)).rejects.toThrow(/capabilities must be an array/);
});

it('rejects capability missing from', async () => {
  const p = join(dir, 'bad-cap-from.yaml');
  await writeFile(p, "capabilities:\n  - name: git-write\n");
  await expect(parseManifest(p)).rejects.toThrow(/capability needs string 'name' and 'from'/);
});

it('rejects subagents that is not an array', async () => {
  const p = join(dir, 'bad-subs.yaml');
  await writeFile(p, 'subagents:\n  name: oops\n');
  await expect(parseManifest(p)).rejects.toThrow(/subagents must be an array/);
});

it('rejects subagent missing name', async () => {
  const p = join(dir, 'bad-sub-name.yaml');
  await writeFile(p, 'subagents:\n  - systemPrompt: hi\n');
  await expect(parseManifest(p)).rejects.toThrow(/subagent missing 'name'/);
});

it('accepts subagent with promptTemplate (no systemPrompt)', async () => {
  const p = join(dir, 'tmpl.yaml');
  await writeFile(p, 'subagents:\n  - name: tmpl-bot\n    promptTemplate: ./tpl.md\n');
  const m = await parseManifest(p);
  expect(m.subagents?.[0].promptTemplate).toBe('./tpl.md');
});

it('rejects envs that is not an array', async () => {
  const p = join(dir, 'bad-envs.yaml');
  await writeFile(p, 'envs:\n  name: oops\n');
  await expect(parseManifest(p)).rejects.toThrow(/envs must be an array/);
});

it('rejects env missing name', async () => {
  const p = join(dir, 'bad-env-name.yaml');
  await writeFile(p, 'envs:\n  - values:\n      X: y\n');
  await expect(parseManifest(p)).rejects.toThrow(/env missing 'name'/);
});

it('accepts an empty manifest', async () => {
  const p = join(dir, 'empty.yaml');
  await writeFile(p, '{}\n');
  const m = await parseManifest(p);
  expect(m).toEqual({});
});
