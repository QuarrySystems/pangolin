import { attachSubagentCmd } from '../src/cmd-subagent.js';
import { Command } from 'commander';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, describe, vi, afterEach } from 'vitest';

// Shape-valid config-supplied provider used to exercise the `getSyncProviders`
// seam without a built-in name colliding with it. See providers/registry.ts
// validateEntry for the required shape.
const probeProvider = {
  name: 'probe',
  defaultSubagentDir: '.',
  defaultCapabilityDir: '.',
  loadSubagents: async () => [{ name: 'probed-agent' }],
  loadCapabilities: async () => [{ name: 'probed-cap', files: {} }],
};

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

  // Every other config-provider test in this suite uses --dry-run, which returns
  // before `getClient()` is ever called. Without this one, nothing anywhere
  // proves a config-supplied provider's output actually reaches
  // client.subagent.register() — the headline user story ends one step short.
  it('sync registers a CONFIG-SUPPLIED provider output (non-dry-run)', async () => {
    const mockRegister = vi.fn(async (def: { name: string }) => ({
      name: def.name,
      contentHash: `sha256:${def.name}-hash`,
      registeredAt: '2026-05-28T00:00:00Z',
    }));
    const mockClient = { subagent: { register: mockRegister } };
    const getSyncProviders = vi.fn(async () => ({
      providers: [probeProvider],
      source: 'pangolin.config.mjs',
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachSubagentCmd(program, { getClient: async () => mockClient as any, getSyncProviders });
    await program.parseAsync([
      'node', 'pangolin', 'subagent', 'sync', '--provider', 'probe',
    ]);

    expect(getSyncProviders).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledWith({ name: 'probed-agent' });
  });

  it('sync --dry-run skips registration and never calls getClient or getSyncProviders for a built-in provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pangolin-sync-sub-dry-'));
    await writeFile(join(dir, 'g.md'), '---\nname: g\n---\nbody\n', 'utf8');

    const getClient = vi.fn(async () => ({} as any));
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachSubagentCmd(program, {
      getClient,
      // A built-in name (claude-code) must short-circuit before getExtra is
      // ever awaited — resolveProviderLazily's whole point. Throwing here
      // proves it, rather than a no-op fake that would pass either way.
      getSyncProviders: async () => {
        throw new Error('getSyncProviders should not be called for a built-in provider');
      },
    });
    await program.parseAsync([
      'node', 'pangolin', 'subagent', 'sync',
      '--provider', 'claude-code', '--from', dir, '--dry-run',
    ]);

    expect(getClient).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('(dry-run) subagent g');
  });

  it('sync --provider probe resolves a config-supplied provider via getSyncProviders', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachSubagentCmd(program, {
      getClient: async () => ({} as any),
      getSyncProviders: async () => ({ providers: [probeProvider], source: 'pangolin.config.ts' }),
    });
    await program.parseAsync([
      'node', 'pangolin', 'subagent', 'sync',
      '--provider', 'probe', '--from', '.', '--dry-run',
    ]);

    expect(consoleSpy).toHaveBeenCalledWith('(dry-run) subagent probed-agent');
  });

  it('sync rejects unknown providers', async () => {
    const program = new Command();
    attachSubagentCmd(program, {
      getClient: async () => ({} as any),
      getSyncProviders: async () => null,
    });
    await expect(
      program.parseAsync([
        'node', 'pangolin', 'subagent', 'sync', '--provider', 'made-up', '--from', '.',
      ]),
    ).rejects.toThrow(/unknown --provider 'made-up'/);
  });

  it('sync --help succeeds without invoking a throwing getSyncProviders fake', async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    attachSubagentCmd(program, {
      getClient: async () => ({} as any),
      getSyncProviders: async () => {
        throw new Error('getSyncProviders should not be called by --help');
      },
    });

    await expect(
      program.parseAsync(['node', 'pangolin', 'subagent', 'sync', '--help']),
    ).rejects.toMatchObject({ code: 'commander.helpDisplayed' });
  });
});
