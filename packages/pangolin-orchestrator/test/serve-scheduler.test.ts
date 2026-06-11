// packages/pangolin-orchestrator/test/serve-scheduler.test.ts
import { describe, it, expect, vi } from 'vitest';
import { PangolinOrchestrator, SqliteRunStateStore, ManualTrigger } from '../src/index.js';
import type { SubmissionEnvelope, SubmissionTransport, OutboxRecord } from '../src/index.js';
import { serve } from '../src/serve/driver.js';
import { immediateExecutor } from './fixtures/executors.js';

// Local per-file fake (repo convention — see serve-driver.test.ts). Records submit() calls.
function makeSubmitRecordingTransport(): SubmissionTransport & { submitted: string[] } {
  const submitted: string[] = [];
  return {
    submitted,
    submit: async (e: SubmissionEnvelope) => { submitted.push(e.run.id); return e.run.id; },
    pollInbox: async () => [],
    ack: async () => {},
    deadLetter: async () => {},
    publish: async (_r: OutboxRecord) => {},
    readOutbox: async () => [],
  };
}

describe('serve + scheduler', () => {
  it('submits each due envelope through the transport for its due tick', async () => {
    const env: SubmissionEnvelope = {
      run: { id: 'nightly@slot', items: [] } as SubmissionEnvelope['run'],
      actor: 'human:test',
      submittedAt: '2026-06-03T04:00:00.000Z',
    };
    const scheduler = {
      dueSubmissions: vi.fn().mockReturnValueOnce([env]).mockReturnValue([]),
    };
    const transport = makeSubmitRecordingTransport();
    const orchestrator = new PangolinOrchestrator({
      store: new SqliteRunStateStore(),
      executors: { immediate: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 1 } },
    });
    const ac = new AbortController();
    const loop = serve({
      orchestrator,
      transport,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scheduler: scheduler as any,
      signal: ac.signal,
      tickIntervalMs: 1,
    });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await loop;
    expect(transport.submitted).toContain('nightly@slot');
  });

  it('a dueSubmissions() error is caught by onError and does not crash the loop', async () => {
    const throwingScheduler = {
      dueSubmissions: vi.fn().mockImplementation(() => { throw new Error('store offline'); }),
    };
    const transport = makeSubmitRecordingTransport();
    const orchestrator = new PangolinOrchestrator({
      store: new SqliteRunStateStore(),
      executors: { immediate: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 1 } },
    });
    const errors: unknown[] = [];
    const ac = new AbortController();
    const loop = serve({
      orchestrator,
      transport,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scheduler: throwingScheduler as any,
      signal: ac.signal,
      tickIntervalMs: 1,
      onError: (err) => errors.push(err),
    });
    // Let it run several iterations without crashing
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await loop;
    expect(errors.length).toBeGreaterThan(0);
    expect((errors[0] as Error).message).toBe('store offline');
  });

  it('omitting scheduler leaves V1 behaviour unchanged — no submit calls from scheduler', async () => {
    const transport = makeSubmitRecordingTransport();
    const orchestrator = new PangolinOrchestrator({
      store: new SqliteRunStateStore(),
      executors: { immediate: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 1 } },
    });
    const ac = new AbortController();
    ac.abort(); // abort immediately — V1 behaviour
    await serve({ orchestrator, transport, signal: ac.signal, tickIntervalMs: 1 });
    expect(transport.submitted).toHaveLength(0);
  });
});
