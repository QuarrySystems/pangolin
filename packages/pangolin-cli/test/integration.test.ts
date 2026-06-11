// End-to-end integration suite for the `pangolin` CLI.
//
// Drives the full commander program (buildProgram + all attach* helpers)
// against a fake PangolinClient implemented with vi.fn() spies — no real
// storage, no Docker, no AWS. Verifies:
//   - the subcommand surface composes cleanly (every attach* coexists),
//   - the dispatch flag parser forwards JSON `--input` to client.dispatch,
//   - the deploy reconciler walks a sample manifest and registers in the
//     documented phase order (capabilities → subagents → envs),
//   - malformed `--input` JSON surfaces as a thrown SyntaxError (non-zero
//     exit when the CLI is invoked from a shell),
//   - happy-path subcommands complete without throwing (exit 0 surrogate).
//
// The manifest YAML is written in block style (not flow) because the temp
// directory path on Windows contains a `:` (e.g. `C:/Users/...`) which would
// be misparsed by YAML inside a flow-style mapping.

import { buildProgram } from '../src/index.js';
import { attachCapabilitiesCmd } from '../src/cmd-capabilities.js';
import { attachSubagentCmd } from '../src/cmd-subagent.js';
import { attachEnvCmd } from '../src/cmd-env.js';
import { attachDispatchCmd } from '../src/cmd-dispatch.js';
import { attachDeployCmd } from '../src/cmd-deploy.js';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

interface FakeClient {
  capabilities: {
    register: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
  subagent: {
    register: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
  env: {
    register: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
  dispatch: ReturnType<typeof vi.fn> & {
    describe: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  };
}

function makeFakeClient(): FakeClient {
  const dispatchFn = vi.fn(async () => ({
    dispatchId: 'd1',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 0,
    resolved: {
      subagent: { name: 's1', contentHash: 'sha256:s', registeredAt: '2026' },
      capabilities: [],
      env: [],
    },
  })) as FakeClient['dispatch'];
  dispatchFn.describe = vi.fn(async () => ({
    dispatchId: 'd1',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 0,
    resolved: {
      subagent: { name: 's1', contentHash: 'sha256:s', registeredAt: '2026' },
      capabilities: [],
      env: [],
    },
  }));
  dispatchFn.cancel = vi.fn(async () => {});

  return {
    capabilities: {
      register: vi.fn(async (opts: { name: string }) => ({
        name: opts.name,
        contentHash: 'sha256:cap',
        registeredAt: '2026',
      })),
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
    },
    subagent: {
      register: vi.fn(async (opts: { name: string }) => ({
        name: opts.name,
        contentHash: 'sha256:sub',
        registeredAt: '2026',
      })),
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
    },
    env: {
      register: vi.fn(async (opts: { name: string }) => ({
        name: opts.name,
        contentHash: 'sha256:env',
        registeredAt: '2026',
      })),
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
    },
    dispatch: dispatchFn,
  };
}

function buildAll(fakeClient: FakeClient) {
  const ctx = {
    getClient: async () => fakeClient as any,
    // Minimal stub: satisfies the required field; throws lazily if any orch
    // verb is actually invoked (none of these integration tests exercise orch).
    getOrchContext: async (): Promise<import('../src/cmd-orch.js').OrchContext> => {
      throw new Error('orch not configured in integration test ctx');
    },
  };
  // buildProgram now wires every attach*Cmd internally (since the index.ts
  // bin fix); the explicit per-command attaches that used to live here
  // would now double-register and commander throws.
  return buildProgram(ctx);
}

describe('pangolin-cli integration', () => {
  let manifestDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    manifestDir = await mkdtemp(join(tmpdir(), 'cli-int-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    await rm(manifestDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('composes the full subcommand surface (capabilities, subagent, env, dispatch, deploy, orch, pipeline, verify)', () => {
    const fake = makeFakeClient();
    const program = buildAll(fake);
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual(['capabilities', 'deploy', 'dispatch', 'env', 'orch', 'pipeline', 'subagent', 'verify']);
  });

  it('dispatch run forwards --subagent, --target, and parsed --input JSON to client.dispatch', async () => {
    const fake = makeFakeClient();
    const program = buildAll(fake);

    await program.parseAsync([
      'node',
      'pangolin',
      'dispatch',
      'run',
      '--subagent',
      's1',
      '--target',
      't1',
      '--input',
      '{"k":"v"}',
      '--worker-image',
      'busybox@sha256:0000000000000000000000000000000000000000000000000000000000000000',
    ]);

    expect(fake.dispatch).toHaveBeenCalledTimes(1);
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        subagent: 's1',
        target: 't1',
        input: { k: 'v' },
        workerImage: 'busybox@sha256:0000000000000000000000000000000000000000000000000000000000000000',
      }),
    );
  });

  it('dispatch run rejects malformed --input JSON cleanly (exit non-zero surrogate)', async () => {
    const fake = makeFakeClient();
    const program = buildAll(fake);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit(1)');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        program.parseAsync([
          'node',
          'pangolin',
          'dispatch',
          'run',
          '--subagent',
          's1',
          '--target',
          't1',
          '--input',
          '{not valid json',
        ]),
      ).rejects.toThrow(/process\.exit/);

      expect(exitSpy).toHaveBeenCalledWith(1);
      // Bad parse must abort before we hit the client.
      expect(fake.dispatch).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('deploy reconciler walks a sample manifest in order: capabilities → subagents → envs', async () => {
    const fake = makeFakeClient();
    const program = buildAll(fake);

    // Capability bundle directory with one file.
    const capDir = join(manifestDir, 'caps', 'foo');
    await mkdir(capDir, { recursive: true });
    await writeFile(join(capDir, 'settings.json'), '{}');

    // Block-style YAML so the Windows `C:` in the path isn't misparsed as a
    // YAML mapping key. Absolute paths in `from:` skip the cwd-relative
    // resolution that cmd-deploy.ts would otherwise apply.
    const manifestPath = join(manifestDir, 'pangolin-manifest.yaml');
    const capFromForYaml = capDir.replace(/\\/g, '/');
    await writeFile(
      manifestPath,
      [
        'capabilities:',
        '  - name: foo',
        `    from: "${capFromForYaml}"`,
        'subagents:',
        '  - name: s1',
        '    systemPrompt: hi',
        '    capabilities: [foo]',
        'envs:',
        '  - name: e',
        '    values:',
        '      K: v',
        '',
      ].join('\n'),
    );

    await program.parseAsync(['node', 'pangolin', 'deploy', '--from', manifestPath]);

    expect(fake.capabilities.register).toHaveBeenCalledTimes(1);
    expect(fake.subagent.register).toHaveBeenCalledTimes(1);
    expect(fake.env.register).toHaveBeenCalledTimes(1);

    // Strict ordering: capability invocation must precede subagent, which
    // must precede env. Use vi's monotonic invocationCallOrder.
    const capOrder = fake.capabilities.register.mock.invocationCallOrder[0];
    const subOrder = fake.subagent.register.mock.invocationCallOrder[0];
    const envOrder = fake.env.register.mock.invocationCallOrder[0];
    expect(capOrder).toBeLessThan(subOrder);
    expect(subOrder).toBeLessThan(envOrder);

    // The capability bundle was forwarded with the expected file map.
    const capCall = fake.capabilities.register.mock.calls[0][0] as {
      name: string;
      files: Record<string, Uint8Array>;
    };
    expect(capCall.name).toBe('foo');
    expect(Object.keys(capCall.files)).toEqual(['settings.json']);

    // The subagent was forwarded with its inline systemPrompt + caps list
    // (per the actual cmd-deploy contract, not the subagent.from-file form).
    const subCall = fake.subagent.register.mock.calls[0][0] as {
      name: string;
      systemPrompt?: string;
      capabilities?: string[];
    };
    expect(subCall.name).toBe('s1');
    expect(subCall.systemPrompt).toBe('hi');
    expect(subCall.capabilities).toEqual(['foo']);

    // The env was forwarded with its values map.
    const envCall = fake.env.register.mock.calls[0][0] as {
      name: string;
      values?: Record<string, string>;
    };
    expect(envCall.name).toBe('e');
    expect(envCall.values).toEqual({ K: 'v' });
  });

  it('capabilities list completes successfully against an empty registry (exit 0 happy path)', async () => {
    const fake = makeFakeClient();
    const program = buildAll(fake);
    await expect(
      program.parseAsync(['node', 'pangolin', 'capabilities', 'list']),
    ).resolves.not.toThrow();
    expect(fake.capabilities.list).toHaveBeenCalledTimes(1);
  });

  it('env get prints (not found) when the lookup returns null', async () => {
    const fake = makeFakeClient();
    const program = buildAll(fake);
    await program.parseAsync(['node', 'pangolin', 'env', 'get', 'nope']);
    expect(fake.env.get).toHaveBeenCalledWith('nope');
    expect(logSpy).toHaveBeenCalledWith('(not found)');
  });

  it('deploy halts on first failure — later phases (subagent, env) are not invoked', async () => {
    const fake = makeFakeClient();
    fake.capabilities.register.mockRejectedValueOnce(new Error('register-boom'));

    const program = buildAll(fake);

    const capDir = join(manifestDir, 'caps', 'foo');
    await mkdir(capDir, { recursive: true });
    await writeFile(join(capDir, 'x'), 'x');

    const manifestPath = join(manifestDir, 'pangolin-manifest.yaml');
    const capFromForYaml = capDir.replace(/\\/g, '/');
    await writeFile(
      manifestPath,
      [
        'capabilities:',
        '  - name: foo',
        `    from: "${capFromForYaml}"`,
        'subagents:',
        '  - name: s1',
        '    systemPrompt: hi',
        'envs:',
        '  - name: e',
        '    values: { K: v }',
        '',
      ].join('\n'),
    );

    await expect(
      program.parseAsync(['node', 'pangolin', 'deploy', '--from', manifestPath]),
    ).rejects.toThrow(/register-boom/);

    expect(fake.subagent.register).not.toHaveBeenCalled();
    expect(fake.env.register).not.toHaveBeenCalled();
  });
});
