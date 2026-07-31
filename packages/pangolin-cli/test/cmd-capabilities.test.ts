import { attachCapabilitiesCmd } from '../src/cmd-capabilities.js';
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

  // Mirrors the subagent side: every other config-provider test here uses
  // --dry-run, which returns before `getClient()` is called, so nothing
  // otherwise proves a config-supplied provider's bundles reach
  // client.capabilities.register().
  it('sync registers a CONFIG-SUPPLIED provider output (non-dry-run)', async () => {
    const mockRegister = vi.fn(async (b: { name: string }) => ({
      name: b.name,
      contentHash: `sha256:${b.name}-hash`,
      registeredAt: '2026-05-28T00:00:00Z',
    }));
    const mockClient = { capabilities: { register: mockRegister } };
    const getSyncProviders = vi.fn(async () => ({
      providers: [probeProvider],
      source: 'pangolin.config.mjs',
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachCapabilitiesCmd(program, {
      getClient: async () => mockClient as any,
      getSyncProviders,
    });
    await program.parseAsync([
      'node', 'pangolin', 'capabilities', 'sync', '--provider', 'probe',
    ]);

    expect(getSyncProviders).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledWith({ name: 'probed-cap', files: {} });
  });

  it('sync --dry-run skips registration and never calls getClient or getSyncProviders for a built-in provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pangolin-sync-cap-dry-'));
    await mkdir(join(dir, 's'), { recursive: true });
    await writeFile(join(dir, 's', 'SKILL.md'), 'body', 'utf8');

    const getClient = vi.fn(async () => ({} as any));
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachCapabilitiesCmd(program, {
      getClient,
      // A built-in name (claude-code) must short-circuit before getExtra is
      // ever awaited — resolveProviderLazily's whole point. Throwing here
      // proves it, rather than a no-op fake that would pass either way.
      getSyncProviders: async () => {
        throw new Error('getSyncProviders should not be called for a built-in provider');
      },
    });
    await program.parseAsync([
      'node', 'pangolin', 'capabilities', 'sync',
      '--provider', 'claude-code', '--from', dir, '--dry-run',
    ]);

    expect(getClient).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('(dry-run) capability s');
  });

  it('sync --provider probe resolves a config-supplied provider via getSyncProviders', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachCapabilitiesCmd(program, {
      getClient: async () => ({} as any),
      getSyncProviders: async () => ({ providers: [probeProvider], source: 'pangolin.config.ts' }),
    });
    await program.parseAsync([
      'node', 'pangolin', 'capabilities', 'sync',
      '--provider', 'probe', '--from', '.', '--dry-run',
    ]);

    expect(consoleSpy).toHaveBeenCalledWith('(dry-run) capability probed-cap');
  });

  it('sync --help succeeds without invoking a throwing getSyncProviders fake', async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    attachCapabilitiesCmd(program, {
      getClient: async () => ({} as any),
      getSyncProviders: async () => {
        throw new Error('getSyncProviders should not be called by --help');
      },
    });

    await expect(
      program.parseAsync(['node', 'pangolin', 'capabilities', 'sync', '--help']),
    ).rejects.toMatchObject({ code: 'commander.helpDisplayed' });
  });
});
