// `pangolin deploy --from <manifest>` reconciler tests.
//
// Covers: command wiring, manifest walk order (capabilities → subagents →
// envs), per-entry console emission (`<type> <name>\t<contentHash>`), and
// halt-on-failure semantics (first error aborts; later entries are not
// touched).

import { attachDeployCmd } from '../src/cmd-deploy.js';
import { Command } from 'commander';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let originalCwd: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'deploy-'));
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('attachDeployCmd', () => {
  it('attachDeployCmd registers the deploy subcommand', () => {
    const program = new Command();
    attachDeployCmd(program, { getClient: async () => ({} as any) });
    expect(program.commands.map((c) => c.name())).toContain('deploy');
  });

  it('registers capabilities → subagents → envs in manifest order', async () => {
    const call: string[] = [];

    // Capability bundle directory containing one file.
    await mkdir(join(dir, 'caps', 'git-write'), { recursive: true });
    await writeFile(join(dir, 'caps', 'git-write', 'tool.json'), '{}');

    const manifestPath = join(dir, 'pangolin.config.yaml');
    await writeFile(
      manifestPath,
      [
        'capabilities:',
        '  - name: git-write',
        '    from: ./caps/git-write',
        'subagents:',
        '  - name: code-reviewer',
        '    systemPrompt: review code',
        '    capabilities: [git-write]',
        'envs:',
        '  - name: prod',
        '    values:',
        '      LOG_LEVEL: info',
        '',
      ].join('\n'),
    );

    const mockClient = {
      capabilities: {
        register: vi.fn(async (opts: { name: string }) => {
          call.push(`cap:${opts.name}`);
          return { name: opts.name, contentHash: 'sha256:cap', registeredAt: 't0' };
        }),
      },
      subagent: {
        register: vi.fn(async (opts: { name: string }) => {
          call.push(`sub:${opts.name}`);
          return { name: opts.name, contentHash: 'sha256:sub', registeredAt: 't1' };
        }),
      },
      env: {
        register: vi.fn(async (opts: { name: string }) => {
          call.push(`env:${opts.name}`);
          return { name: opts.name, contentHash: 'sha256:env', registeredAt: 't2' };
        }),
      },
    };

    // cd into manifest dir so the relative cap.from resolves.
    process.chdir(dir);

    const program = new Command();
    attachDeployCmd(program, { getClient: async () => mockClient as any });
    await program.parseAsync(['node', 'pangolin', 'deploy', '--from', manifestPath]);

    expect(call).toEqual(['cap:git-write', 'sub:code-reviewer', 'env:prod']);
  });

  it('forwards capability bundle files keyed by relative path', async () => {
    await mkdir(join(dir, 'caps', 'git-write', 'nested'), { recursive: true });
    await writeFile(join(dir, 'caps', 'git-write', 'tool.json'), 'A');
    await writeFile(join(dir, 'caps', 'git-write', 'nested', 'helper.sh'), 'B');

    const manifestPath = join(dir, 'pangolin.config.yaml');
    await writeFile(
      manifestPath,
      [
        'capabilities:',
        '  - name: git-write',
        '    from: ./caps/git-write',
        '',
      ].join('\n'),
    );

    const capRegister = vi.fn(async (opts: { name: string; files: Record<string, Uint8Array> }) => ({
      name: opts.name,
      contentHash: 'sha256:cap',
      registeredAt: 't0',
    }));
    const mockClient = { capabilities: { register: capRegister } };

    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachDeployCmd(program, { getClient: async () => mockClient as any });
    await program.parseAsync(['node', 'pangolin', 'deploy', '--from', manifestPath]);

    expect(capRegister).toHaveBeenCalledTimes(1);
    const arg = capRegister.mock.calls[0][0];
    expect(Object.keys(arg.files).sort()).toEqual(['nested/helper.sh', 'tool.json']);
    // forward-slash normalisation on Windows
    for (const k of Object.keys(arg.files)) {
      expect(k).not.toContain('\\');
    }
  });

  it('emits one-line confirmation per entry as `<type> <name>\\t<hash>`', async () => {
    await mkdir(join(dir, 'caps', 'c1'), { recursive: true });
    await writeFile(join(dir, 'caps', 'c1', 'x'), 'x');
    const manifestPath = join(dir, 'pangolin.config.yaml');
    await writeFile(
      manifestPath,
      [
        'capabilities:',
        '  - name: c1',
        '    from: ./caps/c1',
        'subagents:',
        '  - name: s1',
        '    systemPrompt: hi',
        'envs:',
        '  - name: e1',
        '    values: { K: v }',
        '',
      ].join('\n'),
    );

    const mockClient = {
      capabilities: { register: vi.fn(async () => ({ name: 'c1', contentHash: 'sha256:aaa', registeredAt: 't' })) },
      subagent:     { register: vi.fn(async () => ({ name: 's1', contentHash: 'sha256:bbb', registeredAt: 't' })) },
      env:          { register: vi.fn(async () => ({ name: 'e1', contentHash: 'sha256:ccc', registeredAt: 't' })) },
    };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.chdir(dir);

    const program = new Command();
    attachDeployCmd(program, { getClient: async () => mockClient as any });
    await program.parseAsync(['node', 'pangolin', 'deploy', '--from', manifestPath]);

    expect(consoleSpy).toHaveBeenCalledWith('capability c1\tsha256:aaa');
    expect(consoleSpy).toHaveBeenCalledWith('subagent s1\tsha256:bbb');
    expect(consoleSpy).toHaveBeenCalledWith('env e1\tsha256:ccc');
  });

  it('halts on first failure — subsequent entries are not registered', async () => {
    await mkdir(join(dir, 'caps', 'c1'), { recursive: true });
    await writeFile(join(dir, 'caps', 'c1', 'x'), 'x');
    const manifestPath = join(dir, 'pangolin.config.yaml');
    await writeFile(
      manifestPath,
      [
        'capabilities:',
        '  - name: c1',
        '    from: ./caps/c1',
        'subagents:',
        '  - name: s1',
        '    systemPrompt: hi',
        'envs:',
        '  - name: e1',
        '    values: { K: v }',
        '',
      ].join('\n'),
    );

    const subRegister = vi.fn();
    const envRegister = vi.fn();
    const mockClient = {
      capabilities: {
        register: vi.fn(async () => {
          throw new Error('boom');
        }),
      },
      subagent: { register: subRegister },
      env: { register: envRegister },
    };
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachDeployCmd(program, { getClient: async () => mockClient as any });

    await expect(
      program.parseAsync(['node', 'pangolin', 'deploy', '--from', manifestPath]),
    ).rejects.toThrow(/boom/);
    expect(subRegister).not.toHaveBeenCalled();
    expect(envRegister).not.toHaveBeenCalled();
  });

  it('passes secrets through to env.register unchanged (SecretRef + InlineSecret)', async () => {
    const manifestPath = join(dir, 'pangolin.config.yaml');
    await writeFile(
      manifestPath,
      [
        'envs:',
        '  - name: prod',
        '    values:',
        '      LOG_LEVEL: info',
        '    secrets:',
        '      DB_PASS:',
        '        arn: arn:aws:secretsmanager:us-east-1:123:secret:p',
        '      API_KEY:',
        '        inline: hunter2',
        '',
      ].join('\n'),
    );

    const envRegister = vi.fn(async () => ({ name: 'prod', contentHash: 'sha256:e', registeredAt: 't' }));
    const mockClient = { env: { register: envRegister } };
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachDeployCmd(program, { getClient: async () => mockClient as any });
    await program.parseAsync(['node', 'pangolin', 'deploy', '--from', manifestPath]);

    expect(envRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'prod',
        values: { LOG_LEVEL: 'info' },
        secrets: {
          DB_PASS: { arn: 'arn:aws:secretsmanager:us-east-1:123:secret:p' },
          API_KEY: { inline: 'hunter2' },
        },
      }),
    );
  });

  it('accepts a manifest with only envs (no capabilities or subagents)', async () => {
    const manifestPath = join(dir, 'pangolin.config.yaml');
    await writeFile(manifestPath, 'envs:\n  - name: only\n    values: { X: y }\n');
    const envRegister = vi.fn(async () => ({ name: 'only', contentHash: 'sha256:e', registeredAt: 't' }));
    const mockClient = { env: { register: envRegister } };
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachDeployCmd(program, { getClient: async () => mockClient as any });
    await program.parseAsync(['node', 'pangolin', 'deploy', '--from', manifestPath]);

    expect(envRegister).toHaveBeenCalledOnce();
  });
});
