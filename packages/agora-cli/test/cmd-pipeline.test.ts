// Tests for `agora pipeline` subcommand group.
//
// Mirrors the structure and conventions of cmd-subagent.test.ts:
//   - Mock the client's pipeline.register / pipeline.list methods
//   - Write JSON spec files to temp dirs
//   - Parse argv via program.parseAsync
//   - Assert on mock calls, console output, and process.exit codes
//
// Precedent note for `list`:
//   Both cmd-subagent and cmd-capabilities have a list verb; we follow that
//   pattern (cmd-pipeline.ts PRECEDENT NOTE has the full rationale).
//
// Validate design note:
//   validate is storage-free — it uses registerPipeline with a stub storage
//   to exercise validatePipelineSpec without needing a full AgoraClient.
//   See cmd-pipeline.ts VALIDATE design note for details.

import { attachPipelineCmd } from '../src/cmd-pipeline.js';
import { Command } from 'commander';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, describe, vi, afterEach } from 'vitest';

const VALID_SPEC = {
  schemaVersion: 1,
  id: 'data.transform',
  blocks: [{ kind: 'agent' }],
};

describe('attachPipelineCmd', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  // ── subcommand structure ──────────────────────────────────────────────────

  it('registers register/validate/list subcommands', () => {
    const program = new Command();
    attachPipelineCmd(program, { getClient: async () => ({} as any) });
    const pipe = program.commands.find((c) => c.name() === 'pipeline');
    expect(pipe).toBeDefined();
    const subNames = pipe!.commands.map((c) => c.name()).sort();
    expect(subNames).toEqual(['list', 'register', 'validate']);
  });

  // ── register ─────────────────────────────────────────────────────────────

  it('register: reads JSON file and calls client.pipeline.register, prints ref with pinnedUri', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agora-pipeline-'));
    const specFile = join(dir, 'spec.json');
    await writeFile(specFile, JSON.stringify(VALID_SPEC), 'utf8');

    const mockRegister = vi.fn().mockResolvedValue({
      id: 'data.transform',
      contentHash: 'sha256:abc123',
      registeredAt: '2026-06-06T00:00:00Z',
    });
    const mockClient = { pipeline: { register: mockRegister }, namespace: 'test-ns' };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachPipelineCmd(program, { getClient: async () => mockClient as any });
    await program.parseAsync(['node', 'agora', 'pipeline', 'register', specFile]);

    expect(mockRegister).toHaveBeenCalledWith(VALID_SPEC);
    const printed = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(printed.id).toBe('data.transform');
    expect(printed.contentHash).toBe('sha256:abc123');
    expect(printed.registeredAt).toBe('2026-06-06T00:00:00Z');
    expect(printed.pinnedUri).toBe('agora://test-ns/pipeline/data.transform@sha256:abc123');
  });

  it('register: exits 1 when file does not exist', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((_code?: number | string | null) => {
        throw new Error(`exit:${_code}`);
      });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const program = new Command();
    attachPipelineCmd(program, { getClient: async () => ({} as any) });
    await expect(
      program.parseAsync(['node', 'agora', 'pipeline', 'register', '/no/such/file.json']),
    ).rejects.toThrow(/exit:1/);

    const errorText = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errorText).toMatch(/ENOENT|cannot read/i);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('register: exits 1 and prints all errors when client.pipeline.register throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agora-pipeline-invalid-'));
    const specFile = join(dir, 'bad.json');
    await writeFile(specFile, JSON.stringify({ schemaVersion: 1, id: 'bad_id', blocks: [] }), 'utf8');

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((_code?: number | string | null) => {
        throw new Error(`exit:${_code}`);
      });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockClient = {
      namespace: 'test-ns',
      pipeline: {
        register: vi
          .fn()
          .mockRejectedValue(
            new Error('pipeline.register: invalid spec:\nid "bad_id" must be ...\nblocks must be non-empty'),
          ),
      },
    };

    const program = new Command();
    attachPipelineCmd(program, { getClient: async () => mockClient as any });
    await expect(
      program.parseAsync(['node', 'agora', 'pipeline', 'register', specFile]),
    ).rejects.toThrow(/exit:1/);

    const errorText = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errorText).toMatch(/invalid|error/i);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  // ── validate ─────────────────────────────────────────────────────────────

  it('validate: exits 0 and prints "OK" for a valid spec (no client constructed)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agora-pipeline-val-'));
    const specFile = join(dir, 'spec.json');
    await writeFile(specFile, JSON.stringify(VALID_SPEC), 'utf8');

    const getClient = vi.fn(async () => ({} as any));
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachPipelineCmd(program, { getClient });
    await program.parseAsync(['node', 'agora', 'pipeline', 'validate', specFile]);

    // getClient must NOT be called (storage-free)
    expect(getClient).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('OK'));
  });

  it('validate: exits 1 and prints all errors for an invalid spec (no client constructed)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agora-pipeline-val-'));
    const specFile = join(dir, 'bad.json');
    // schemaVersion 2 is unsupported, id format wrong, blocks empty → multiple errors
    await writeFile(
      specFile,
      JSON.stringify({ schemaVersion: 2, id: 'bad_id', blocks: [] }),
      'utf8',
    );

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((_code?: number | string | null) => {
        throw new Error(`exit:${_code}`);
      });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const getClient = vi.fn(async () => ({} as any));

    const program = new Command();
    attachPipelineCmd(program, { getClient });
    await expect(
      program.parseAsync(['node', 'agora', 'pipeline', 'validate', specFile]),
    ).rejects.toThrow(/exit:1/);

    // getClient must NOT be called
    expect(getClient).not.toHaveBeenCalled();
    // errors must have been emitted — schemaVersion, id, and blocks all fail
    const errorText = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errorText).toMatch(/schemaVersion|id.*must be|blocks/i);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('validate: exits 1 when file does not exist (no client constructed)', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((_code?: number | string | null) => {
        throw new Error(`exit:${_code}`);
      });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const getClient = vi.fn(async () => ({} as any));

    const program = new Command();
    attachPipelineCmd(program, { getClient });
    await expect(
      program.parseAsync(['node', 'agora', 'pipeline', 'validate', '/no/such/file.json']),
    ).rejects.toThrow(/exit:1/);

    expect(getClient).not.toHaveBeenCalled();

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  // ── list ─────────────────────────────────────────────────────────────────

  it('list: calls client.pipeline.list and prints each entry on a tab-delimited line', async () => {
    const mockList = vi.fn().mockResolvedValue([
      { id: 'data.transform', contentHash: 'sha256:abc', registeredAt: '2026-06-06T00:00:00Z' },
      { id: 'ml.inference', contentHash: 'sha256:def', registeredAt: '2026-06-06T01:00:00Z' },
    ]);
    const mockClient = { pipeline: { list: mockList } };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachPipelineCmd(program, { getClient: async () => mockClient as any });
    await program.parseAsync(['node', 'agora', 'pipeline', 'list']);

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith('data.transform\tsha256:abc\t2026-06-06T00:00:00Z');
    expect(consoleSpy).toHaveBeenCalledWith('ml.inference\tsha256:def\t2026-06-06T01:00:00Z');
  });
});
