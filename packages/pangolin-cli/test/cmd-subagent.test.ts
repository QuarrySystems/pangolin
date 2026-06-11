import { attachSubagentCmd } from '../src/cmd-subagent.js';
import { Command } from 'commander';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, describe, vi, afterEach } from 'vitest';

describe('attachSubagentCmd', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers register/assign/list/get/sync subcommands', () => {
    const program = new Command();
    attachSubagentCmd(program, { getClient: async () => ({} as any) });
    const sub = program.commands.find((c) => c.name() === 'subagent');
    expect(sub).toBeDefined();
    const subNames = sub!.commands.map((c) => c.name()).sort();
    expect(subNames).toEqual(['assign', 'get', 'list', 'register', 'sync']);
  });

  it('register builds def from inline flags when --from is omitted', async () => {
    const mockRegister = vi.fn().mockResolvedValue({
      name: 'greeter',
      contentHash: 'sha256:abc',
      registeredAt: '2026-05-28T00:00:00Z',
    });
    const mockClient = { subagent: { register: mockRegister } };
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachSubagentCmd(program, { getClient: async () => mockClient as any });
    await program.parseAsync([
      'node', 'pangolin',
      'subagent', 'register',
      '--name', 'greeter',
      '--system-prompt', 'You greet things and exit.',
      '--capability', 'hello-cap',
      '--capability', 'extra-cap',
      '--model', 'claude-sonnet-4-6',
    ]);

    expect(mockRegister).toHaveBeenCalledWith({
      name: 'greeter',
      systemPrompt: 'You greet things and exit.',
      capabilities: ['hello-cap', 'extra-cap'],
      model: 'claude-sonnet-4-6',
    });
  });

  it('register rejects when both --from and inline flags are given', async () => {
    const program = new Command();
    attachSubagentCmd(program, { getClient: async () => ({} as any) });
    await expect(
      program.parseAsync([
        'node', 'pangolin',
        'subagent', 'register',
        '--name', 'x',
        '--from', 'whatever.yaml',
        '--system-prompt', 'inline too',
      ]),
    ).rejects.toThrow(/either --from .* or inline flags/);
  });

  it('register rejects when neither --from nor any inline flag is given', async () => {
    const program = new Command();
    attachSubagentCmd(program, { getClient: async () => ({} as any) });
    await expect(
      program.parseAsync(['node', 'pangolin', 'subagent', 'register', '--name', 'x']),
    ).rejects.toThrow(/supply --from .* or at least one of/);
  });

  it('sync --provider claude-code walks the dir and registers each agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pangolin-sync-sub-'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'greeter.md'), '---\nname: greeter\n---\nSay hi.\n', 'utf8');
    await writeFile(
      join(dir, 'reviewer.md'),
      '---\nname: reviewer\nmodel: claude-sonnet-4-6\n---\nReview.\n',
      'utf8',
    );

    const mockRegister = vi.fn(async (def: { name: string }) => ({
      name: def.name,
      contentHash: `sha256:${def.name}-hash`,
      registeredAt: '2026-05-28T00:00:00Z',
    }));
    const mockClient = { subagent: { register: mockRegister } };
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachSubagentCmd(program, { getClient: async () => mockClient as any });
    await program.parseAsync([
      'node', 'pangolin', 'subagent', 'sync', '--provider', 'claude-code', '--from', dir,
    ]);

    expect(mockRegister).toHaveBeenCalledTimes(2);
    expect(mockRegister).toHaveBeenCalledWith({ name: 'greeter', systemPrompt: 'Say hi.' });
    expect(mockRegister).toHaveBeenCalledWith({
      name: 'reviewer',
      systemPrompt: 'Review.',
      model: 'claude-sonnet-4-6',
    });
  });

  it('sync --dry-run skips registration and never calls getClient', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pangolin-sync-sub-dry-'));
    await writeFile(join(dir, 'g.md'), '---\nname: g\n---\nbody\n', 'utf8');

    const getClient = vi.fn(async () => ({} as any));
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachSubagentCmd(program, { getClient });
    await program.parseAsync([
      'node', 'pangolin', 'subagent', 'sync',
      '--provider', 'claude-code', '--from', dir, '--dry-run',
    ]);

    expect(getClient).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('(dry-run) subagent g');
  });

  it('sync rejects unknown providers', async () => {
    const program = new Command();
    attachSubagentCmd(program, { getClient: async () => ({} as any) });
    await expect(
      program.parseAsync([
        'node', 'pangolin', 'subagent', 'sync', '--provider', 'made-up', '--from', '.',
      ]),
    ).rejects.toThrow(/unknown --provider 'made-up'/);
  });
});
