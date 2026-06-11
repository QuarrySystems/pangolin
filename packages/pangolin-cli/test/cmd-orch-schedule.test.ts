import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  SubmissionTransport,
  ControlChannel,
  ControlEnvelope,
  OutboxRecord,
  SubmissionEnvelope,
  ScheduleStore,
  Schedule,
} from '@quarry-systems/pangolin-orchestrator';
import { attachOrchCmd, type OrchContext } from '../src/cmd-orch.js';
import type { CliContext } from '../src/index.js';

// ---------------------------------------------------------------------------
// Fake transport (minimal; schedule verbs don't use transport directly)
// ---------------------------------------------------------------------------
function makeFakeTransport(): SubmissionTransport & ControlChannel {
  return {
    async submit(_env: SubmissionEnvelope): Promise<string> { return _env.run.id; },
    async pollInbox(): Promise<SubmissionEnvelope[]> { return []; },
    async ack(_runId: string): Promise<void> {},
    async deadLetter(_runId: string): Promise<void> {},
    async publish(_rec: OutboxRecord): Promise<void> {},
    async readOutbox(_runId: string): Promise<OutboxRecord[]> { return []; },
    async control(_env: ControlEnvelope): Promise<void> {},
    async pollControl(): Promise<ControlEnvelope[]> { return []; },
    async ackControl(_target: string): Promise<void> {},
  };
}

// ---------------------------------------------------------------------------
// Fake ScheduleStore
// ---------------------------------------------------------------------------
function makeFakeScheduleStore(): ScheduleStore & { _schedules: Map<string, Schedule> } {
  const schedules = new Map<string, Schedule>();
  return {
    _schedules: schedules,
    due(_nowMs: number): Schedule[] {
      return [...schedules.values()].filter(s => new Date(s.nextDueAt).getTime() <= _nowMs);
    },
    markFired(id: string, firedAtMs: number, nextDueAt: string): void {
      const s = schedules.get(id);
      if (s) schedules.set(id, { ...s, lastFiredAt: new Date(firedAtMs).toISOString(), nextDueAt });
    },
    upsert(s: Schedule): void {
      schedules.set(s.id, s);
    },
    remove(id: string): void {
      schedules.delete(id);
    },
    list(): Schedule[] {
      return [...schedules.values()];
    },
  };
}

function makeOrchContext(overrides: Partial<OrchContext> = {}): OrchContext {
  const transport = makeFakeTransport();
  return { transport, ...overrides };
}

function makeCtx(oc: OrchContext): CliContext & { getOrchContext: () => Promise<OrchContext> } {
  return {
    getClient: async () => ({} as any),
    getOrchContext: async () => oc,
  };
}

// Capture console.log output during a parseAsync call
async function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const original = console.log;
  console.log = vi.fn((...args: unknown[]) => logs.push(args.map(String).join(' ')));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return logs;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('orch schedule', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'pangolin-cli-schedule-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('add', () => {
    it('upserts a Schedule with nextDueAt computed from cron expr', async () => {
      const store = makeFakeScheduleStore();
      const oc = makeOrchContext({ scheduleStore: store });
      const ctx = makeCtx(oc);

      const run = {
        id: 'template-run-1',
        queue: 'default',
        items: [],
      };
      const planPath = join(tmpDir, 'plan.json');
      await writeFile(planPath, JSON.stringify(run));

      const program = new Command();
      attachOrchCmd(program, ctx);

      const beforeMs = Date.now();
      const logs = await captureLog(() =>
        program.parseAsync(
          ['orch', 'schedule', 'add', '--id', 'nightly', '--cron', '0 2 * * *', '--plan', planPath],
          { from: 'user' },
        ),
      );

      // Should print confirmation with id and nextDueAt
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('nightly');

      // Store should have one schedule
      expect(store._schedules.size).toBe(1);
      const s = store._schedules.get('nightly')!;
      expect(s).toBeDefined();
      expect(s.id).toBe('nightly');
      expect(s.cronExpr).toBe('0 2 * * *');
      expect(s.run.id).toBe('template-run-1');

      // nextDueAt must be a valid ISO string strictly after the test started
      expect(new Date(s.nextDueAt).getTime()).toBeGreaterThan(beforeMs);
    });

    it('is idempotent: re-adding with same id is an upsert, not a duplicate', async () => {
      const store = makeFakeScheduleStore();
      const oc = makeOrchContext({ scheduleStore: store });
      const ctx = makeCtx(oc);

      const run = { id: 'tmpl', queue: 'default', items: [] };
      const planPath = join(tmpDir, 'plan.json');
      await writeFile(planPath, JSON.stringify(run));

      const program = new Command();
      attachOrchCmd(program, ctx);

      await captureLog(() =>
        program.parseAsync(
          ['orch', 'schedule', 'add', '--id', 'daily', '--cron', '0 6 * * *', '--plan', planPath],
          { from: 'user' },
        ),
      );

      // Re-add with different cron — should overwrite, not create a second entry
      const program2 = new Command();
      attachOrchCmd(program2, ctx);

      await captureLog(() =>
        program2.parseAsync(
          ['orch', 'schedule', 'add', '--id', 'daily', '--cron', '0 8 * * *', '--plan', planPath],
          { from: 'user' },
        ),
      );

      expect(store._schedules.size).toBe(1);
      expect(store._schedules.get('daily')!.cronExpr).toBe('0 8 * * *');
    });

    it('fails with an error and makes no store write when cron expr is invalid', async () => {
      const store = makeFakeScheduleStore();
      const oc = makeOrchContext({ scheduleStore: store });
      const ctx = makeCtx(oc);

      const run = { id: 'tmpl', queue: 'default', items: [] };
      const planPath = join(tmpDir, 'plan.json');
      await writeFile(planPath, JSON.stringify(run));

      const program = new Command();
      attachOrchCmd(program, ctx);

      await expect(
        program.parseAsync(
          ['orch', 'schedule', 'add', '--id', 'bad', '--cron', 'not-a-cron', '--plan', planPath],
          { from: 'user' },
        ),
      ).rejects.toThrow();

      // No schedule should have been written
      expect(store._schedules.size).toBe(0);
    });

    it('fails with a clear message when no scheduleStore is configured', async () => {
      const oc = makeOrchContext(); // no scheduleStore
      const ctx = makeCtx(oc);

      const run = { id: 'tmpl', queue: 'default', items: [] };
      const planPath = join(tmpDir, 'plan.json');
      await writeFile(planPath, JSON.stringify(run));

      const program = new Command();
      attachOrchCmd(program, ctx);

      await expect(
        program.parseAsync(
          ['orch', 'schedule', 'add', '--id', 'x', '--cron', '0 0 * * *', '--plan', planPath],
          { from: 'user' },
        ),
      ).rejects.toThrow('no scheduleStore');
    });

    it('uses --actor flag when provided', async () => {
      const store = makeFakeScheduleStore();
      const oc = makeOrchContext({ scheduleStore: store });
      const ctx = makeCtx(oc);

      const run = { id: 'tmpl', queue: 'default', items: [] };
      const planPath = join(tmpDir, 'plan.json');
      await writeFile(planPath, JSON.stringify(run));

      const program = new Command();
      attachOrchCmd(program, ctx);

      await captureLog(() =>
        program.parseAsync(
          ['orch', 'schedule', 'add', '--id', 'weekly', '--cron', '0 3 * * 1', '--plan', planPath, '--actor', 'agent:bot'],
          { from: 'user' },
        ),
      );

      expect(store._schedules.get('weekly')!.actor).toBe('agent:bot');
    });
  });

  describe('list', () => {
    it('prints id, cron, last-fired, next-due for each schedule', async () => {
      const store = makeFakeScheduleStore();
      const now = Date.now();

      const s1: Schedule = {
        id: 'sched-a',
        cronExpr: '0 2 * * *',
        run: { id: 'tmpl-a', queue: 'default', items: [] },
        actor: 'human:brett',
        nextDueAt: new Date(now + 3_600_000).toISOString(),
      };
      const s2: Schedule = {
        id: 'sched-b',
        cronExpr: '*/5 * * * *',
        run: { id: 'tmpl-b', queue: 'default', items: [] },
        actor: 'human:brett',
        lastFiredAt: new Date(now - 60_000).toISOString(),
        nextDueAt: new Date(now + 240_000).toISOString(),
      };
      store.upsert(s1);
      store.upsert(s2);

      const oc = makeOrchContext({ scheduleStore: store });
      const ctx = makeCtx(oc);

      const program = new Command();
      attachOrchCmd(program, ctx);

      const logs = await captureLog(() =>
        program.parseAsync(['orch', 'schedule', 'list'], { from: 'user' }),
      );

      expect(logs).toHaveLength(2);

      const line1 = logs.find(l => l.includes('sched-a'))!;
      expect(line1).toContain('0 2 * * *');
      expect(line1).toContain('-');        // no lastFiredAt
      expect(line1).toContain(s1.nextDueAt);

      const line2 = logs.find(l => l.includes('sched-b'))!;
      expect(line2).toContain('*/5 * * * *');
      expect(line2).toContain(s2.lastFiredAt!);
      expect(line2).toContain(s2.nextDueAt);
    });

    it('prints nothing when store is empty', async () => {
      const store = makeFakeScheduleStore();
      const oc = makeOrchContext({ scheduleStore: store });
      const ctx = makeCtx(oc);

      const program = new Command();
      attachOrchCmd(program, ctx);

      const logs = await captureLog(() =>
        program.parseAsync(['orch', 'schedule', 'list'], { from: 'user' }),
      );

      expect(logs).toHaveLength(0);
    });

    it('fails with a clear message when no scheduleStore configured', async () => {
      const oc = makeOrchContext(); // no scheduleStore
      const ctx = makeCtx(oc);

      const program = new Command();
      attachOrchCmd(program, ctx);

      await expect(
        program.parseAsync(['orch', 'schedule', 'list'], { from: 'user' }),
      ).rejects.toThrow('no scheduleStore');
    });
  });

  describe('rm', () => {
    it('removes a schedule by id', async () => {
      const store = makeFakeScheduleStore();
      const s: Schedule = {
        id: 'to-remove',
        cronExpr: '0 0 * * *',
        run: { id: 'tmpl', queue: 'default', items: [] },
        actor: 'human:brett',
        nextDueAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
      store.upsert(s);
      expect(store._schedules.size).toBe(1);

      const oc = makeOrchContext({ scheduleStore: store });
      const ctx = makeCtx(oc);

      const program = new Command();
      attachOrchCmd(program, ctx);

      const logs = await captureLog(() =>
        program.parseAsync(['orch', 'schedule', 'rm', '--id', 'to-remove'], { from: 'user' }),
      );

      expect(store._schedules.size).toBe(0);
      expect(logs[0]).toContain('to-remove');
      expect(logs[0]).toContain('removed');
    });

    it('is a no-op when the schedule id does not exist', async () => {
      const store = makeFakeScheduleStore();
      const oc = makeOrchContext({ scheduleStore: store });
      const ctx = makeCtx(oc);

      const program = new Command();
      attachOrchCmd(program, ctx);

      // Should not throw
      await expect(
        captureLog(() =>
          program.parseAsync(['orch', 'schedule', 'rm', '--id', 'nonexistent'], { from: 'user' }),
        ),
      ).resolves.toBeDefined();

      expect(store._schedules.size).toBe(0);
    });

    it('fails with a clear message when no scheduleStore configured', async () => {
      const oc = makeOrchContext(); // no scheduleStore
      const ctx = makeCtx(oc);

      const program = new Command();
      attachOrchCmd(program, ctx);

      await expect(
        program.parseAsync(['orch', 'schedule', 'rm', '--id', 'x'], { from: 'user' }),
      ).rejects.toThrow('no scheduleStore');
    });
  });
});
