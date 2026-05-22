import { describe, it, expect, vi } from 'vitest';
import type {
  DispatchResult,
  LifecycleEvent,
  TaskExit,
  TaskHandle,
} from '@quarry-systems/agora-core';
import {
  NoopCredentialProvider,
  NoopTelemetryHook,
  StdoutResultSink,
} from '../src/bundled-impls.js';

const resolvedFixture: DispatchResult['resolved'] = {
  subagent: {
    name: 'demo-subagent',
    versionId: 'v1',
    contentHash: 'sha256:' + 'a'.repeat(64),
  } as DispatchResult['resolved']['subagent'],
  capabilities: [],
};

describe('NoopCredentialProvider', () => {
  it('exposes name "none"', () => {
    expect(new NoopCredentialProvider().name).toBe('none');
  });

  it('resolves to {kind: "none"}', async () => {
    const creds = await new NoopCredentialProvider().resolve();
    expect(creds).toEqual({ kind: 'none' });
  });
});

describe('NoopTelemetryHook', () => {
  it('exposes name "noop"', () => {
    expect(new NoopTelemetryHook().name).toBe('noop');
  });

  it('emit() drops events without throwing', () => {
    const hook = new NoopTelemetryHook();
    const event: LifecycleEvent = {
      kind: 'dispatch.accepted',
      dispatchId: 'd1',
      target: 't',
      resolved: [],
      at: '2026-05-21T00:00:00Z',
    };
    expect(() => hook.emit(event)).not.toThrow();
    expect(hook.emit(event)).toBeUndefined();
  });
});

describe('StdoutResultSink', () => {
  const handle: TaskHandle = { providerTaskId: 'pid-1' };

  function makeExit(overrides: Partial<TaskExit> = {}): TaskExit {
    return {
      exitCode: 0,
      startedAt: new Date('2026-05-21T00:00:00Z'),
      finishedAt: new Date('2026-05-21T00:00:00.500Z'),
      stdout: 'ok',
      stderr: '',
      ...overrides,
    };
  }

  it('exposes name "stdout"', () => {
    expect(new StdoutResultSink().name).toBe('stdout');
  });

  it('produces a DispatchResult echoing dispatchId, exitCode, resolved, and durationMs', async () => {
    const sink = new StdoutResultSink();
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const result = await sink.collect(handle, makeExit({ exitCode: 7 }), {
        dispatchId: 'dispatch-abc',
        resolved: resolvedFixture,
      });
      expect(result.dispatchId).toBe('dispatch-abc');
      expect(result.exitCode).toBe(7);
      expect(result.durationMs).toBe(500);
      expect(result.resolved).toBe(resolvedFixture);
      expect(result.stdout).toBe('ok');
      expect(result.stderr).toBe('');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('writes a one-line JSON summary to process.stdout (not the full body)', async () => {
    const sink = new StdoutResultSink();
    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });
    try {
      await sink.collect(handle, makeExit({ stdout: 'gigantic-payload-not-in-summary' }), {
        dispatchId: 'dispatch-xyz',
        resolved: resolvedFixture,
      });
      expect(writes).toHaveLength(1);
      const line = writes[0]!;
      expect(line.endsWith('\n')).toBe(true);
      // Exactly one newline (the trailing one)
      expect(line.match(/\n/g)!.length).toBe(1);
      const parsed = JSON.parse(line.trim()) as Record<string, unknown>;
      expect(parsed).toEqual({
        kind: 'dispatch.finished',
        dispatchId: 'dispatch-xyz',
        exitCode: 0,
      });
      // The summary does NOT contain the stdout body.
      expect(line).not.toContain('gigantic-payload-not-in-summary');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('truncates stdout above 4 MiB and appends a marker', async () => {
    const sink = new StdoutResultSink();
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const big = 'x'.repeat(5 * 1024 * 1024);
      const result = await sink.collect(handle, makeExit({ stdout: big }), {
        dispatchId: 'd',
        resolved: resolvedFixture,
      });
      expect(result.stdout.length).toBeLessThan(big.length);
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(result.stdout).toContain('truncated at 4 MiB');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('truncates stderr above 256 KiB and appends a marker', async () => {
    const sink = new StdoutResultSink();
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const big = 'e'.repeat(300 * 1024);
      const result = await sink.collect(handle, makeExit({ stderr: big }), {
        dispatchId: 'd',
        resolved: resolvedFixture,
      });
      expect(result.stderr.length).toBeLessThan(big.length);
      expect(Buffer.byteLength(result.stderr, 'utf8')).toBeLessThanOrEqual(256 * 1024);
      expect(result.stderr).toContain('truncated at 256 KiB');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('does not truncate stdout/stderr within their caps', async () => {
    const sink = new StdoutResultSink();
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const out = 'a'.repeat(1024);
      const err = 'b'.repeat(1024);
      const result = await sink.collect(handle, makeExit({ stdout: out, stderr: err }), {
        dispatchId: 'd',
        resolved: resolvedFixture,
      });
      expect(result.stdout).toBe(out);
      expect(result.stderr).toBe(err);
    } finally {
      writeSpy.mockRestore();
    }
  });
});
