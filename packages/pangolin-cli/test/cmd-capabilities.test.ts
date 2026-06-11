import { attachCapabilitiesCmd } from '../src/cmd-capabilities.js';
import { Command } from 'commander';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, describe, vi, afterEach } from 'vitest';

describe('attachCapabilitiesCmd', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers register/list/get/sync subcommands', () => {
    const program = new Command();
    attachCapabilitiesCmd(program, { getClient: async () => ({} as any) });
    const caps = program.commands.find((c) => c.name() === 'capabilities')!;
    const subNames = caps.commands.map((c) => c.name()).sort();
    expect(subNames).toEqual(['get', 'list', 'register', 'sync']);
  });

  it('sync --provider claude-code bundles each skill dir and registers it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pangolin-sync-cap-'));
    await mkdir(join(dir, 'my-skill', 'references'), { recursive: true });
    await writeFile(join(dir, 'my-skill', 'SKILL.md'), 'body', 'utf8');
    await writeFile(join(dir, 'my-skill', 'references', 'a.md'), 'ref', 'utf8');

    const mockRegister = vi.fn(async (b: { name: string }) => ({
      name: b.name,
      contentHash: `sha256:${b.name}-hash`,
      registeredAt: '2026-05-28T00:00:00Z',
    }));
    const mockClient = { capabilities: { register: mockRegister } };
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachCapabilitiesCmd(program, { getClient: async () => mockClient as any });
    await program.parseAsync([
      'node', 'pangolin', 'capabilities', 'sync',
      '--provider', 'claude-code', '--from', dir,
    ]);

    expect(mockRegister).toHaveBeenCalledTimes(1);
    const [bundle] = mockRegister.mock.calls[0];
    expect(bundle.name).toBe('my-skill');
    expect(Object.keys(bundle.files).sort()).toEqual([
      '.claude/skills/my-skill/SKILL.md',
      '.claude/skills/my-skill/references/a.md',
    ]);
  });

  it('sync --dry-run skips registration and never calls getClient', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pangolin-sync-cap-dry-'));
    await mkdir(join(dir, 's'), { recursive: true });
    await writeFile(join(dir, 's', 'SKILL.md'), 'body', 'utf8');

    const getClient = vi.fn(async () => ({} as any));
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachCapabilitiesCmd(program, { getClient });
    await program.parseAsync([
      'node', 'pangolin', 'capabilities', 'sync',
      '--provider', 'claude-code', '--from', dir, '--dry-run',
    ]);

    expect(getClient).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('(dry-run) capability s');
  });
});
