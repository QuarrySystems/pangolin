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
} from '@quarry-systems/pangolin-orchestrator';
import { attachOrchCmd, type OrchContext } from '../src/cmd-orch.js';
import type { CliContext } from '../src/index.js';

// ---------------------------------------------------------------------------
// Fake transport (in-memory, mirrors operations-api.test.ts)
// ---------------------------------------------------------------------------
function makeFakeTransport(): SubmissionTransport & ControlChannel & {
  _submissions: SubmissionEnvelope[];
  _controls: ControlEnvelope[];
  _outbox: Map<string, OutboxRecord[]>;
} {
  const submissions: SubmissionEnvelope[] = [];
  const controls: ControlEnvelope[] = [];
  const outbox = new Map<string, OutboxRecord[]>();

  return {
    _submissions: submissions,
    _controls: controls,
    _outbox: outbox,

    async submit(env: SubmissionEnvelope): Promise<string> {
      submissions.push(env);
      return env.run.id;
    },
    async pollInbox(): Promise<SubmissionEnvelope[]> { return [...submissions]; },
    async ack(_runId: string): Promise<void> {},
    async deadLetter(_runId: string): Promise<void> {},
    async publish(rec: OutboxRecord): Promise<void> {
      const existing = outbox.get(rec.runId) ?? [];
      existing.push(rec);
      outbox.set(rec.runId, existing);
    },
    async readOutbox(runId: string): Promise<OutboxRecord[]> {
      return outbox.get(runId) ?? [];
    },
    async control(env: ControlEnvelope): Promise<void> {
      controls.push(env);
    },
    async pollControl(): Promise<ControlEnvelope[]> { return [...controls]; },
    async ackControl(_target: string): Promise<void> {},
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

describe('attachOrchCmd', () => {
  it('registers serve|submit|status|watch|cancel|audit|schedule|validate|render subcommands + orchestrator alias', () => {
    const program = new Command();
    const ctx = makeCtx(makeOrchContext());
    attachOrchCmd(program, ctx);

    const orchCmd = program.commands.find((c) => c.name() === 'orch')!;
    expect(orchCmd).toBeDefined();
    expect(orchCmd.aliases()).toContain('orchestrator');
    const names = orchCmd.commands.map((c) => c.name()).sort();
    expect(names).toEqual(['audit', 'cancel', 'render', 'schedule', 'serve', 'status', 'submit', 'validate', 'watch']);
  });

  describe('submit', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'pangolin-cli-test-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('translates a plan into OperationsApi.submit and prints the run id', async () => {
      const transport = makeFakeTransport();
      const oc = makeOrchContext({ transport });
      const ctx = makeCtx(oc);

      const run = {
        id: 'run-test-1',
        queue: 'default',
        items: [{ id: 'item-1', executor: 'noop', inputs: {}, depends_on: [], resourceLocks: [] }],
      };
      const planPath = join(tmpDir, 'plan.json');
      await writeFile(planPath, JSON.stringify(run));

      const program = new Command();
      attachOrchCmd(program, ctx);

      const logs = await captureLog(() =>
        program.parseAsync(['orch', 'submit', planPath], { from: 'user' }),
      );

      // Should have printed the run id
      expect(logs).toHaveLength(1);
      expect(logs[0]).toBe('run-test-1');

      // Transport should have received the submission
      expect(transport._submissions).toHaveLength(1);
      expect(transport._submissions[0].run.id).toBe('run-test-1');
    });

    it('resolves actor from PANGOLIN_ACTOR env var when --actor not passed', async () => {
      const transport = makeFakeTransport();
      const oc = makeOrchContext({ transport });
      const ctx = makeCtx(oc);

      const run = {
        id: 'run-actor-test',
        queue: 'default',
        items: [],
      };
      const planPath = join(tmpDir, 'plan.json');
      await writeFile(planPath, JSON.stringify(run));

      const origEnv = process.env.PANGOLIN_ACTOR;
      process.env.PANGOLIN_ACTOR = 'human:brett';

      const program = new Command();
      attachOrchCmd(program, ctx);

      try {
        await captureLog(() =>
          program.parseAsync(['orch', 'submit', planPath], { from: 'user' }),
        );
        expect(transport._submissions[0].actor).toBe('human:brett');
      } finally {
        if (origEnv === undefined) delete process.env.PANGOLIN_ACTOR;
        else process.env.PANGOLIN_ACTOR = origEnv;
      }
    });

    it('uses --actor flag to override actor resolution', async () => {
      const transport = makeFakeTransport();
      const oc = makeOrchContext({ transport });
      const ctx = makeCtx(oc);

      const run = {
        id: 'run-explicit-actor',
        queue: 'default',
        items: [],
      };
      const planPath = join(tmpDir, 'plan.json');
      await writeFile(planPath, JSON.stringify(run));

      const program = new Command();
      attachOrchCmd(program, ctx);

      await captureLog(() =>
        program.parseAsync(['orch', 'submit', planPath, '--actor', 'agent:bot'], { from: 'user' }),
      );

      expect(transport._submissions[0].actor).toBe('agent:bot');
    });
  });

  describe('cancel', () => {
    it('writes a cancel control request via OperationsApi.cancel', async () => {
      const transport = makeFakeTransport();
      const oc = makeOrchContext({ transport });
      const ctx = makeCtx(oc);

      const program = new Command();
      attachOrchCmd(program, ctx);

      const logs = await captureLog(() =>
        program.parseAsync(['orch', 'cancel', 'run-xyz', '--actor', 'human:brett'], { from: 'user' }),
      );

      // Should print confirmation
      expect(logs[0]).toContain('cancel requested');
      expect(logs[0]).toContain('run-xyz');

      // Transport should have received a cancel control envelope
      expect(transport._controls).toHaveLength(1);
      expect(transport._controls[0].kind).toBe('cancel');
      expect(transport._controls[0].target).toBe('run-xyz');
      expect(transport._controls[0].actor).toBe('human:brett');
    });

    it('uses PANGOLIN_ACTOR env var as actor fallback for cancel', async () => {
      const transport = makeFakeTransport();
      const oc = makeOrchContext({ transport });
      const ctx = makeCtx(oc);

      const origEnv = process.env.PANGOLIN_ACTOR;
      process.env.PANGOLIN_ACTOR = 'human:tester';

      const program = new Command();
      attachOrchCmd(program, ctx);

      try {
        await captureLog(() =>
          program.parseAsync(['orch', 'cancel', 'run-abc'], { from: 'user' }),
        );
        expect(transport._controls[0].actor).toBe('human:tester');
      } finally {
        if (origEnv === undefined) delete process.env.PANGOLIN_ACTOR;
        else process.env.PANGOLIN_ACTOR = origEnv;
      }
    });
  });

  describe('status', () => {
    it('prints the latest status record as JSON', async () => {
      const transport = makeFakeTransport();
      const oc = makeOrchContext({ transport });
      const ctx = makeCtx(oc);

      const rec: OutboxRecord = {
        runId: 'run-s1',
        kind: 'status',
        body: [{ id: 'item-1', runId: 'run-s1', status: 'done', blockedBy: [] }],
        at: '2026-06-01T10:00:00Z',
      };
      await transport.publish(rec);

      const program = new Command();
      attachOrchCmd(program, ctx);

      const logs = await captureLog(() =>
        program.parseAsync(['orch', 'status', 'run-s1'], { from: 'user' }),
      );

      expect(logs).toHaveLength(1);
      const parsed = JSON.parse(logs[0]);
      expect(parsed.runId).toBe('run-s1');
      expect(parsed.kind).toBe('status');
    });

    it('prints null when no status record exists', async () => {
      const transport = makeFakeTransport();
      const oc = makeOrchContext({ transport });
      const ctx = makeCtx(oc);

      const program = new Command();
      attachOrchCmd(program, ctx);

      const logs = await captureLog(() =>
        program.parseAsync(['orch', 'status', 'run-missing'], { from: 'user' }),
      );

      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0])).toBeNull();
    });
  });

  describe('watch --json (raw stream format pin)', () => {
    it('prints each raw status record as one JSON line and terminates when all items are terminal', async () => {
      // Build a transport whose readOutbox returns a status record with all items done.
      // OperationsApi.watch yields each record and stops when isTerminalStatusBody returns true
      // (i.e. every item.status is in {done|failed|skipped|cancelled}).
      const transport = makeFakeTransport();
      const oc = makeOrchContext({ transport });
      const ctx = makeCtx(oc);

      const terminalStatusRec: OutboxRecord = {
        runId: 'run-watch-1',
        kind: 'status',
        body: [
          { id: 'item-1', runId: 'run-watch-1', status: 'done', blockedBy: [] },
          { id: 'item-2', runId: 'run-watch-1', status: 'failed', blockedBy: [] },
        ],
        at: '2026-06-01T12:00:00Z',
      };
      await transport.publish(terminalStatusRec);

      const program = new Command();
      attachOrchCmd(program, ctx);

      // The transport already has a terminal record on the first poll — watch
      // yields once, sees terminal body, and returns without sleeping.
      const logs = await captureLog(() =>
        program.parseAsync(['orch', 'watch', 'run-watch-1', '--json'], { from: 'user' }),
      );

      // Format pin: exactly one JSON.parse-able line per poll, whole-record shape.
      expect(logs).toHaveLength(1);
      const parsed = JSON.parse(logs[0]);
      expect(parsed.runId).toBe('run-watch-1');
      expect(parsed.kind).toBe('status');
      expect(parsed.body).toEqual(terminalStatusRec.body);
      expect(parsed.at).toBe('2026-06-01T12:00:00Z');
      // The command must have returned (not hung); if it hung, captureLog would never resolve
    });
  });

  describe('watch (live view default)', () => {
    // Bound the post-terminal audit-summary retry so tests never sleep for real
    // (the production defaults are 15 retries x 1000 ms).
    let savedRetries: string | undefined;
    let savedRetryMs: string | undefined;

    beforeEach(() => {
      savedRetries = process.env.PANGOLIN_WATCH_AUDIT_RETRIES;
      savedRetryMs = process.env.PANGOLIN_WATCH_AUDIT_RETRY_MS;
      process.env.PANGOLIN_WATCH_AUDIT_RETRIES = '1';
      process.env.PANGOLIN_WATCH_AUDIT_RETRY_MS = '0';
    });

    afterEach(() => {
      if (savedRetries === undefined) delete process.env.PANGOLIN_WATCH_AUDIT_RETRIES;
      else process.env.PANGOLIN_WATCH_AUDIT_RETRIES = savedRetries;
      if (savedRetryMs === undefined) delete process.env.PANGOLIN_WATCH_AUDIT_RETRY_MS;
      else process.env.PANGOLIN_WATCH_AUDIT_RETRY_MS = savedRetryMs;
    });

    /** Fake transport whose readOutbox advances through scripted per-call results
     *  (the stock fake returns the full accumulated list, so status() always sees
     *  the latest record — useless for simulating poll-over-poll progression). */
    function makeSequencedTransport(sequences: OutboxRecord[][]): ReturnType<typeof makeFakeTransport> {
      const t = makeFakeTransport();
      let call = 0;
      t.readOutbox = async () => {
        const idx = Math.min(call, sequences.length - 1);
        call++;
        return sequences[idx]!;
      };
      return t;
    }

    it('renders frames, dedups identical polls, and notes the missing audit export', async () => {
      const runId = 'run-live-1';
      const recA: OutboxRecord = {
        runId, kind: 'status',
        body: [{ id: 'item-1', runId, status: 'running', blockedBy: [], depends_on: [] }],
        at: '2026-06-01T12:00:00Z',
      };
      const recB: OutboxRecord = {
        runId, kind: 'status',
        body: [{ id: 'item-1', runId, status: 'done', blockedBy: [], depends_on: [] }],
        at: '2026-06-01T12:00:05Z',
      };
      // A, A (identical poll — must dedup), B (terminal)
      const transport = makeSequencedTransport([[recA], [recA], [recB]]);
      const oc = makeOrchContext({ transport });   // NO storage — evidence path must skip silently
      const ctx = makeCtx(oc);

      const program = new Command();
      attachOrchCmd(program, ctx);

      const logs = await captureLog(() =>
        program.parseAsync(['orch', 'watch', runId, '--interval', '0', '--no-clear', '--no-color'], { from: 'user' }),
      );

      // Two distinct frames + the no-audit note. The duplicate poll produced no frame.
      expect(logs).toHaveLength(3);
      expect(logs[0]).toContain('item-1');
      expect(logs[0]).toContain('state: running');
      expect(logs[1]).toContain('state: terminal');
      expect(logs[0]).not.toEqual(logs[1]);
      expect(logs[2]).toContain('no audit export published');
    });

    it('skips non-status records seen before the first status publishes', async () => {
      const runId = 'run-live-2';
      const nonStatus: OutboxRecord = {
        runId, kind: 'audit', body: { runId }, at: '2026-06-01T12:00:00Z',
      };
      const recDone: OutboxRecord = {
        runId, kind: 'status',
        body: [{ id: 'item-1', runId, status: 'done', blockedBy: [], depends_on: [] }],
        at: '2026-06-01T12:00:05Z',
      };
      const transport = makeSequencedTransport([[nonStatus], [nonStatus, recDone]]);
      const oc = makeOrchContext({ transport });
      const ctx = makeCtx(oc);

      const program = new Command();
      attachOrchCmd(program, ctx);

      const logs = await captureLog(() =>
        program.parseAsync(['orch', 'watch', runId, '--interval', '0', '--no-clear', '--no-color'], { from: 'user' }),
      );

      // Exactly one frame (from the status record) + the no-audit note; the
      // non-status record neither crashed the loop nor rendered a frame.
      expect(logs).toHaveLength(2);
      expect(logs[0]).toContain('item-1');
      expect(logs[0]).toContain('state: terminal');
      expect(logs[1]).toContain('no audit export published');
    });

    it('fills per-item evidence from storage best-effort (manifestRef → dispatch output.json)', async () => {
      const runId = 'run-live-3';
      const recDone: OutboxRecord = {
        runId, kind: 'status',
        body: [{
          id: 'item-1', runId, status: 'done', blockedBy: [], depends_on: [],
          manifestRef: 'pangolin://ns1/manifests/d-1',
        }],
        at: '2026-06-01T12:00:00Z',
      };
      const transport = makeSequencedTransport([[recDone]]);
      const seenRefs: string[] = [];
      const storage = {
        async get(ref: string): Promise<Uint8Array> {
          seenRefs.push(ref);
          return new TextEncoder().encode(JSON.stringify({
            usage: { models: ['m1'], costUsd: 0.25, turns: 3 },
          }));
        },
      };
      const oc = makeOrchContext({ transport, storage });
      const ctx = makeCtx(oc);

      const program = new Command();
      attachOrchCmd(program, ctx);

      const logs = await captureLog(() =>
        program.parseAsync(['orch', 'watch', runId, '--interval', '0', '--no-clear', '--no-color'], { from: 'user' }),
      );

      expect(seenRefs).toEqual(['pangolin://ns1/dispatches/d-1/output.json']);
      expect(logs[0]).toContain('m1');
      expect(logs[0]).toContain('$0.25');
      expect(logs[0]).toContain('3t');
    });

    it('still renders frames when a storage evidence read throws', async () => {
      const runId = 'run-live-4';
      const recDone: OutboxRecord = {
        runId, kind: 'status',
        body: [{
          id: 'item-1', runId, status: 'done', blockedBy: [], depends_on: [],
          manifestRef: 'pangolin://ns1/manifests/d-1',
        }],
        at: '2026-06-01T12:00:00Z',
      };
      const transport = makeSequencedTransport([[recDone]]);
      const storage = {
        async get(_ref: string): Promise<Uint8Array> { throw new Error('boom'); },
      };
      const oc = makeOrchContext({ transport, storage });
      const ctx = makeCtx(oc);

      const program = new Command();
      attachOrchCmd(program, ctx);

      const logs = await captureLog(() =>
        program.parseAsync(['orch', 'watch', runId, '--interval', '0', '--no-clear', '--no-color'], { from: 'user' }),
      );

      expect(logs[0]).toContain('item-1');
      expect(logs[0]).toContain('state: terminal');
    });

    it('repaints in place by default (cursor-up + clear by previous frame height)', async () => {
      const runId = 'run-live-5';
      const recA: OutboxRecord = {
        runId, kind: 'status',
        body: [{ id: 'item-1', runId, status: 'running', blockedBy: [], depends_on: [] }],
        at: '2026-06-01T12:00:00Z',
      };
      const recB: OutboxRecord = {
        runId, kind: 'status',
        body: [{ id: 'item-1', runId, status: 'done', blockedBy: [], depends_on: [] }],
        at: '2026-06-01T12:00:05Z',
      };
      const transport = makeSequencedTransport([[recA], [recB]]);
      const oc = makeOrchContext({ transport });
      const ctx = makeCtx(oc);

      const program = new Command();
      attachOrchCmd(program, ctx);

      const writes: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
        writes.push(String(chunk));
        return true;
      });
      let frameLogs: string[] = [];
      try {
        frameLogs = await captureLog(() =>
          program.parseAsync(['orch', 'watch', runId, '--interval', '0', '--no-color'], { from: 'user' }),
        );
      } finally {
        spy.mockRestore();
      }

      // No clear before the FIRST frame. Before the second frame: cursor up by
      // (first frame height + 1) then clear-to-end. The +1 accounts for the trailing
      // newline that console.log appends — the frame occupies (lineCount+1) terminal rows.
      //
      // frameLogs[0] is what console.log printed for the first frame: frame.join('\n').
      // Its line count  = frameLogs[0].split('\n').length
      // Terminal rows consumed = line count + 1  (the implicit trailing newline from console.log)
      // Expected rewind count  = line count + 1
      const firstFrameLineCount = frameLogs[0].split('\n').length;
      const expectedRewind = firstFrameLineCount + 1;

      // Assert the escape sequence is present and the rewind count is correct.
      const escSeq = writes.find((w) => /\x1b\[\d+A\x1b\[0J/.test(w));
      expect(escSeq).toMatch(/\x1b\[\d+A\x1b\[0J/);
      const rewindMatch = escSeq!.match(/\x1b\[(\d+)A\x1b\[0J/)!;
      expect(Number(rewindMatch[1])).toBe(expectedRewind);
    });

    it('prints the verify summary when the audit export appears late (bounded retry)', async () => {
      process.env.PANGOLIN_WATCH_AUDIT_RETRIES = '2';
      process.env.PANGOLIN_WATCH_AUDIT_RETRY_MS = '0';

      const { SqliteRunStateStore } = await import('@quarry-systems/pangolin-orchestrator');
      const { AuditLog } = await import('@quarry-systems/pangolin-orchestrator/src/audit/audit-log.js');
      const { LocalAnchor } = await import('@quarry-systems/pangolin-orchestrator/src/audit/anchor.js');

      const store = new SqliteRunStateStore();
      const anchor = new LocalAnchor(store);
      const fakeSigner = { async sign() { return { alg: 'none', bytes: new Uint8Array(0) }; } };
      const log = new AuditLog({ store, signer: fakeSigner, anchor });

      const runId = 'run-live-audit-late';
      log.append({ runId, kind: 'run.submitted', actor: 'human:test', at: '2026-06-01T00:00:00Z' });
      log.append({ runId, kind: 'run.completed', at: '2026-06-01T00:01:00Z' });
      await log.sealEpoch(runId);

      const entries = store.getAuditEntries(runId);
      const root = store.getAuditRoot(runId);
      const exp = { runId, entries, root, items: [{ id: 'item-1', status: 'done' }] };

      const recDone: OutboxRecord = {
        runId, kind: 'status',
        body: [{ id: 'item-1', runId, status: 'done', blockedBy: [], depends_on: [] }],
        at: '2026-06-01T00:01:30Z',
      };
      const auditRec: OutboxRecord = { runId, kind: 'audit', body: exp, at: '2026-06-01T00:02:00Z' };

      // Poll 1 (watch): terminal status, NO audit export yet.
      // Audit attempt 1: still no export → retry. Attempt 2: export published → summary.
      const transport = makeSequencedTransport([[recDone], [recDone], [recDone, auditRec]]);
      const storage = {
        async get(_ref: string): Promise<Uint8Array> { throw new Error('no manifests'); },
      };
      const oc = makeOrchContext({ transport, anchor, storage });
      const ctx = makeCtx(oc);

      const program = new Command();
      attachOrchCmd(program, ctx);

      const prevExitCode = process.exitCode;
      process.exitCode = undefined;
      try {
        const logs = await captureLog(() =>
          program.parseAsync(['orch', 'watch', runId, '--interval', '0', '--no-clear', '--no-color'], { from: 'user' }),
        );

        // Frame first, then the verification summary (no "missing export" note).
        expect(logs[0]).toContain('state: terminal');
        expect(logs.some((l) => l.includes('pangolin verify'))).toBe(true);
        expect(logs.some((l) => l.includes('no audit export published'))).toBe(false);
        expect(process.exitCode).not.toBe(1);
      } finally {
        process.exitCode = prevExitCode;
      }
    });
  });

  describe('render', () => {
    let tmpDir: string;
    let savedExitCode: typeof process.exitCode;
    let stderrLines: string[];
    let origError: typeof console.error;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'pangolin-cli-render-'));
      savedExitCode = process.exitCode;
      process.exitCode = undefined;
      stderrLines = [];
      origError = console.error;
      console.error = vi.fn((...args: unknown[]) => stderrLines.push(args.map(String).join(' ')));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
      process.exitCode = savedExitCode;
      console.error = origError;
    });

    /** render must work with NO config file — getOrchContext THROWS. */
    function throwingCtx(): CliContext {
      return {
        getClient: async () => ({} as any),
        getOrchContext: async () => { throw new Error('getOrchContext must not be called by render'); },
      };
    }

    const gatePlan = {
      id: 'run-render-1',
      queue: 'q',
      items: [
        { id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
        {
          id: 'b', executor: 'x',
          inputs: { gate: { onRed: 'spawn-fix', subject: 'a', fixTemplate: { executor: 'x', inputs: {} } } },
          depends_on: ['a'], resourceLocks: [],
        },
        { id: 'c', executor: 'x', inputs: {}, depends_on: ['b'], resourceLocks: [] },
      ],
    };

    it('--pattern pipeline shows the ghost arc for a spawn-fix gate plan (and never touches the orch context)', async () => {
      const planPath = join(tmpDir, 'plan.json');
      await writeFile(planPath, JSON.stringify(gatePlan));

      const program = new Command();
      attachOrchCmd(program, throwingCtx());

      const logs = await captureLog(() =>
        program.parseAsync(['orch', 'render', planPath, '--pattern', 'pipeline'], { from: 'user' }),
      );

      expect(logs).toHaveLength(1);
      const out = logs[0];
      // Ghost arc dotted under the gate
      expect(out).toContain('┊ b-fix-1');
      expect(out).toContain('┊ b~2');
      expect(out).toContain('┊ c~2');
      // Pre-run footer
      expect(out).toContain('state: pre-run');
      expect(process.exitCode).not.toBe(1);
    });

    it('--ascii substitutes ASCII glyphs', async () => {
      const planPath = join(tmpDir, 'plan.json');
      await writeFile(planPath, JSON.stringify(gatePlan));

      const program = new Command();
      attachOrchCmd(program, throwingCtx());

      const logs = await captureLog(() =>
        program.parseAsync(['orch', 'render', planPath, '--pattern', 'pipeline', '--ascii'], { from: 'user' }),
      );

      expect(logs[0]).toContain('[:] b-fix-1');
      expect(logs[0]).not.toContain('┊');
    });

    it('renders a generic tree when --pattern is omitted', async () => {
      const planPath = join(tmpDir, 'plan.json');
      await writeFile(planPath, JSON.stringify({
        id: 'run-render-tree',
        queue: 'q',
        items: [
          { id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
          { id: 'b', executor: 'x', inputs: {}, depends_on: ['a'], resourceLocks: [] },
        ],
      }));

      const program = new Command();
      attachOrchCmd(program, throwingCtx());

      const logs = await captureLog(() =>
        program.parseAsync(['orch', 'render', planPath], { from: 'user' }),
      );

      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('· a');
      expect(logs[0]).toContain('· b');
      expect(logs[0]).toContain('state: pre-run');
    });

    it('reports an unknown --pattern as a clean CLI error', async () => {
      const planPath = join(tmpDir, 'plan.json');
      await writeFile(planPath, JSON.stringify(gatePlan));

      const program = new Command();
      attachOrchCmd(program, throwingCtx());

      await captureLog(() =>
        program.parseAsync(['orch', 'render', planPath, '--pattern', 'bogus'], { from: 'user' }),
      );

      expect(process.exitCode).toBe(1);
      expect(stderrLines.length).toBeGreaterThan(0);
      expect(stderrLines[0]).toContain('unknown pattern');
    });

    it('reports an unreadable plan file as a clean CLI error', async () => {
      const program = new Command();
      attachOrchCmd(program, throwingCtx());

      await captureLog(() =>
        program.parseAsync(['orch', 'render', join(tmpDir, 'nope.json')], { from: 'user' }),
      );

      expect(process.exitCode).toBe(1);
      expect(stderrLines.length).toBeGreaterThan(0);
      expect(stderrLines[0]).toContain('render: cannot read plan');
    });

    it('surfaces pattern.plan() errors as clean CLI errors (mirrors validate)', async () => {
      const planPath = join(tmpDir, 'plan.json');
      await writeFile(planPath, JSON.stringify({
        id: 'run-render-bad-mr',
        queue: 'q',
        items: [
          { id: 'split', executor: 'x', inputs: { mapReduce: 'bogus' }, depends_on: [], resourceLocks: [] },
        ],
      }));

      const program = new Command();
      attachOrchCmd(program, throwingCtx());

      await captureLog(() =>
        program.parseAsync(['orch', 'render', planPath, '--pattern', 'map-reduce'], { from: 'user' }),
      );

      expect(process.exitCode).toBe(1);
      expect(stderrLines.length).toBeGreaterThan(0);
      expect(stderrLines[0]).toContain('render:');
      expect(stderrLines[0]).toContain('map-reduce');
    });
  });

  describe('audit', () => {
    it('calls through OperationsApi.audit and prints the bundle JSON', async () => {
      // Import orchestrator internals for building a realistic audit export
      const { SqliteRunStateStore } = await import('@quarry-systems/pangolin-orchestrator');
      const { AuditLog } = await import('@quarry-systems/pangolin-orchestrator/src/audit/audit-log.js');
      const { LocalAnchor } = await import('@quarry-systems/pangolin-orchestrator/src/audit/anchor.js');

      const transport = makeFakeTransport();

      const store = new SqliteRunStateStore();
      const anchor = new LocalAnchor(store);
      const fakeSigner = { async sign() { return { alg: 'none', bytes: new Uint8Array(0) }; } };
      const log = new AuditLog({ store, signer: fakeSigner, anchor });

      const runId = 'run-audit-cli-1';
      log.append({ runId, kind: 'run.submitted', actor: 'human:test', at: '2026-06-01T00:00:00Z' });
      log.append({ runId, kind: 'run.completed', at: '2026-06-01T00:01:00Z' });
      await log.sealEpoch(runId);

      const entries = store.getAuditEntries(runId);
      const root = store.getAuditRoot(runId);
      const exp = { runId, entries, root, items: [{ id: 'item-1', status: 'done' }] };

      await transport.publish({ runId, kind: 'audit', body: exp, at: '2026-06-01T00:02:00Z' });

      const storage = {
        async get(_ref: string): Promise<Uint8Array> { throw new Error('no manifests'); },
      };

      const oc = makeOrchContext({ transport, anchor, storage });
      const ctx = makeCtx(oc);

      const program = new Command();
      attachOrchCmd(program, ctx);

      const logs = await captureLog(() =>
        program.parseAsync(['orch', 'audit', runId], { from: 'user' }),
      );

      expect(logs).toHaveLength(1);
      const bundle = JSON.parse(logs[0]);
      expect(bundle.runId).toBe(runId);
      expect(bundle.report.intact).toBe(true);
      // Should not set nonzero exit when intact
      expect(process.exitCode).not.toBe(1);
    });

    it('sets process.exitCode = 1 when report.intact is false', async () => {
      // Build a valid audit export then tamper with an entry's content so the
      // chain hash check fails during verify(), producing intact=false.
      const { SqliteRunStateStore } = await import('@quarry-systems/pangolin-orchestrator');
      const { AuditLog } = await import('@quarry-systems/pangolin-orchestrator/src/audit/audit-log.js');
      const { LocalAnchor } = await import('@quarry-systems/pangolin-orchestrator/src/audit/anchor.js');

      const transport = makeFakeTransport();

      const store = new SqliteRunStateStore();
      const anchor = new LocalAnchor(store);
      const fakeSigner = { async sign() { return { alg: 'none', bytes: new Uint8Array(0) }; } };
      const log = new AuditLog({ store, signer: fakeSigner, anchor });

      const runId = 'run-audit-cli-tampered';
      log.append({ runId, kind: 'run.submitted', actor: 'human:test', at: '2026-06-01T00:00:00Z' });
      log.append({ runId, kind: 'run.completed', at: '2026-06-01T00:01:00Z' });
      await log.sealEpoch(runId);

      const entries = store.getAuditEntries(runId);
      const root = store.getAuditRoot(runId);

      // Tamper: modify an entry's entryHash so chain hash verification fails.
      // verify() recomputes chainHash(canonEntry(e), prev) and checks it equals e.entryHash.
      const tamperedEntries = entries.map((e, i) =>
        i === 0 ? { ...e, entryHash: 'tampered-entry-hash' } : e,
      );
      const exp = { runId, entries: tamperedEntries, root, items: [{ id: 'item-1', status: 'done' }] };

      await transport.publish({ runId, kind: 'audit', body: exp, at: '2026-06-01T00:02:00Z' });

      const storage = {
        async get(_ref: string): Promise<Uint8Array> { throw new Error('no manifests'); },
      };

      const oc = makeOrchContext({ transport, anchor, storage });
      const ctx = makeCtx(oc);

      const program = new Command();
      attachOrchCmd(program, ctx);

      const prevExitCode = process.exitCode;
      process.exitCode = undefined;
      try {
        await captureLog(() =>
          program.parseAsync(['orch', 'audit', runId], { from: 'user' }),
        );
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = prevExitCode;
      }
    });

    it('writes audit bundle to --out file when specified', async () => {
      const { SqliteRunStateStore } = await import('@quarry-systems/pangolin-orchestrator');
      const { AuditLog } = await import('@quarry-systems/pangolin-orchestrator/src/audit/audit-log.js');
      const { LocalAnchor } = await import('@quarry-systems/pangolin-orchestrator/src/audit/anchor.js');

      const transport = makeFakeTransport();
      const store = new SqliteRunStateStore();
      const anchor = new LocalAnchor(store);
      const fakeSigner = { async sign() { return { alg: 'none', bytes: new Uint8Array(0) }; } };
      const log = new AuditLog({ store, signer: fakeSigner, anchor });

      const runId = 'run-audit-cli-out';
      log.append({ runId, kind: 'run.submitted', actor: 'human:test', at: '2026-06-01T00:00:00Z' });
      log.append({ runId, kind: 'run.completed', at: '2026-06-01T00:01:00Z' });
      await log.sealEpoch(runId);

      const entries = store.getAuditEntries(runId);
      const root = store.getAuditRoot(runId);
      const exp = { runId, entries, root, items: [] };
      await transport.publish({ runId, kind: 'audit', body: exp, at: '2026-06-01T00:02:00Z' });

      const storage = {
        async get(_ref: string): Promise<Uint8Array> { throw new Error('no manifests'); },
      };

      const oc = makeOrchContext({ transport, anchor, storage });
      const ctx = makeCtx(oc);

      const tmpDir = await mkdtemp(join(tmpdir(), 'pangolin-cli-audit-'));
      const outPath = join(tmpDir, 'bundle.json');

      try {
        const program = new Command();
        attachOrchCmd(program, ctx);

        const logs = await captureLog(() =>
          program.parseAsync(['orch', 'audit', runId, '--out', outPath], { from: 'user' }),
        );

        // Should NOT print to stdout when --out is set
        expect(logs).toHaveLength(0);

        // Should have written to file
        const { readFile } = await import('node:fs/promises');
        const content = await readFile(outPath, 'utf8');
        const bundle = JSON.parse(content);
        expect(bundle.runId).toBe(runId);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('serve', () => {
    it('calls runService(signal) when provided', async () => {
      const runService = vi.fn().mockResolvedValue(undefined);
      const oc = makeOrchContext({ runService });
      const ctx = makeCtx(oc);

      const program = new Command();
      attachOrchCmd(program, ctx);

      await program.parseAsync(['orch', 'serve'], { from: 'user' });

      expect(runService).toHaveBeenCalledOnce();
      const signal = runService.mock.calls[0][0];
      expect(signal).toBeInstanceOf(AbortSignal);
    });

    it('throws a clear error when runService is not provided in orch context', async () => {
      const oc = makeOrchContext();
      // no runService
      const ctx = makeCtx(oc);

      const program = new Command();
      attachOrchCmd(program, ctx);

      await expect(
        program.parseAsync(['orch', 'serve'], { from: 'user' }),
      ).rejects.toThrow('no runService');
    });
  });

  describe('validate', () => {
    let tmpDir: string;
    let savedExitCode: typeof process.exitCode;
    let stderrLines: string[];
    let origError: typeof console.error;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'pangolin-cli-validate-'));
      savedExitCode = process.exitCode;
      process.exitCode = undefined;
      stderrLines = [];
      origError = console.error;
      console.error = vi.fn((...args: unknown[]) => stderrLines.push(args.map(String).join(' ')));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
      process.exitCode = savedExitCode;
      console.error = origError;
    });

    it('prints valid:true for a well-formed plan and makes no transport calls', async () => {
      const transport = makeFakeTransport();
      const ctx = makeCtx(makeOrchContext({ transport }));
      const planPath = join(tmpDir, 'plan.json');
      await writeFile(planPath, JSON.stringify({
        id: 'r',
        queue: 'default',
        items: [{ id: 'a', executor: 'noop', inputs: {}, depends_on: [], resourceLocks: [] }],
      }));
      const program = new Command();
      attachOrchCmd(program, ctx);
      const logs = await captureLog(() => program.parseAsync(['orch', 'validate', planPath], { from: 'user' }));
      expect(JSON.parse(logs[0]).valid).toBe(true);
      expect(JSON.parse(logs[0]).items).toBe(1);
      expect(transport._submissions).toHaveLength(0);
      expect(process.exitCode).not.toBe(1);
    });

    it('reports each error on stderr and sets exitCode = 1 for an invalid plan (unknown dep)', async () => {
      const transport = makeFakeTransport();
      const ctx = makeCtx(makeOrchContext({ transport }));
      const planPath = join(tmpDir, 'plan-invalid.json');
      await writeFile(planPath, JSON.stringify({
        id: 'r2',
        queue: 'default',
        items: [{ id: 'a', executor: 'noop', inputs: {}, depends_on: ['missing-item'], resourceLocks: [] }],
      }));
      const program = new Command();
      attachOrchCmd(program, ctx);

      await program.parseAsync(['orch', 'validate', planPath], { from: 'user' });
      expect(process.exitCode).toBe(1);
      expect(stderrLines.length).toBeGreaterThan(0);
      expect(stderrLines[0]).toContain('missing-item');
      expect(transport._submissions).toHaveLength(0);
    });

    it('reports a cycle error on stderr and sets exitCode = 1', async () => {
      const transport = makeFakeTransport();
      const ctx = makeCtx(makeOrchContext({ transport }));
      const planPath = join(tmpDir, 'plan-cycle.json');
      await writeFile(planPath, JSON.stringify({
        id: 'r3',
        queue: 'default',
        items: [
          { id: 'a', executor: 'noop', inputs: {}, depends_on: ['b'], resourceLocks: [] },
          { id: 'b', executor: 'noop', inputs: {}, depends_on: ['a'], resourceLocks: [] },
        ],
      }));
      const program = new Command();
      attachOrchCmd(program, ctx);

      await program.parseAsync(['orch', 'validate', planPath], { from: 'user' });
      expect(process.exitCode).toBe(1);
      expect(stderrLines.length).toBeGreaterThan(0);
      expect(stderrLines.some((l) => l.includes('cycle'))).toBe(true);
      expect(transport._submissions).toHaveLength(0);
    });

    it('prints "validate: cannot read plan" to stderr and sets exitCode = 1 for a missing file', async () => {
      const transport = makeFakeTransport();
      const ctx = makeCtx(makeOrchContext({ transport }));
      const missingPath = join(tmpDir, 'nonexistent.json');

      const program = new Command();
      attachOrchCmd(program, ctx);

      await program.parseAsync(['orch', 'validate', missingPath], { from: 'user' });
      expect(process.exitCode).toBe(1);
      expect(stderrLines.length).toBeGreaterThan(0);
      expect(stderrLines[0]).toContain('validate: cannot read plan');
      expect(transport._submissions).toHaveLength(0);
    });

    it('prints "validate: cannot read plan" to stderr and sets exitCode = 1 for an invalid JSON file', async () => {
      const transport = makeFakeTransport();
      const ctx = makeCtx(makeOrchContext({ transport }));
      const badJsonPath = join(tmpDir, 'bad.json');
      await writeFile(badJsonPath, '{ not valid json !!!');

      const program = new Command();
      attachOrchCmd(program, ctx);

      await program.parseAsync(['orch', 'validate', badJsonPath], { from: 'user' });
      expect(process.exitCode).toBe(1);
      expect(stderrLines.length).toBeGreaterThan(0);
      expect(stderrLines[0]).toContain('validate: cannot read plan');
      expect(transport._submissions).toHaveLength(0);
    });
  });
});
