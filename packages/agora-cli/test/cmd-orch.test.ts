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
} from '@quarry-systems/agora-orchestrator';
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
  it('registers serve|submit|status|watch|cancel|audit|schedule subcommands + orchestrator alias', () => {
    const program = new Command();
    const ctx = makeCtx(makeOrchContext());
    attachOrchCmd(program, ctx);

    const orchCmd = program.commands.find((c) => c.name() === 'orch')!;
    expect(orchCmd).toBeDefined();
    expect(orchCmd.aliases()).toContain('orchestrator');
    const names = orchCmd.commands.map((c) => c.name()).sort();
    expect(names).toEqual(['audit', 'cancel', 'schedule', 'serve', 'status', 'submit', 'watch']);
  });

  describe('submit', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'agora-cli-test-'));
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

    it('resolves actor from AGORA_ACTOR env var when --actor not passed', async () => {
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

      const origEnv = process.env.AGORA_ACTOR;
      process.env.AGORA_ACTOR = 'human:brett';

      const program = new Command();
      attachOrchCmd(program, ctx);

      try {
        await captureLog(() =>
          program.parseAsync(['orch', 'submit', planPath], { from: 'user' }),
        );
        expect(transport._submissions[0].actor).toBe('human:brett');
      } finally {
        if (origEnv === undefined) delete process.env.AGORA_ACTOR;
        else process.env.AGORA_ACTOR = origEnv;
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

    it('uses AGORA_ACTOR env var as actor fallback for cancel', async () => {
      const transport = makeFakeTransport();
      const oc = makeOrchContext({ transport });
      const ctx = makeCtx(oc);

      const origEnv = process.env.AGORA_ACTOR;
      process.env.AGORA_ACTOR = 'human:tester';

      const program = new Command();
      attachOrchCmd(program, ctx);

      try {
        await captureLog(() =>
          program.parseAsync(['orch', 'cancel', 'run-abc'], { from: 'user' }),
        );
        expect(transport._controls[0].actor).toBe('human:tester');
      } finally {
        if (origEnv === undefined) delete process.env.AGORA_ACTOR;
        else process.env.AGORA_ACTOR = origEnv;
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

  describe('watch', () => {
    it('prints each status record as JSON and terminates when all items are in a terminal state', async () => {
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

      // Pass intervalMs=0 so watch doesn't sleep between polls
      // We can't pass it via CLI flags (no flag defined), so we rely on the
      // transport already having a terminal record on the first poll — watch
      // yields once, sees terminal body, and returns without sleeping.
      const logs = await captureLog(() =>
        program.parseAsync(['orch', 'watch', 'run-watch-1'], { from: 'user' }),
      );

      // Should print exactly one status record as JSON
      expect(logs).toHaveLength(1);
      const parsed = JSON.parse(logs[0]);
      expect(parsed.runId).toBe('run-watch-1');
      expect(parsed.kind).toBe('status');
      // The command must have returned (not hung); if it hung, captureLog would never resolve
    });
  });

  describe('audit', () => {
    it('calls through OperationsApi.audit and prints the bundle JSON', async () => {
      // Import orchestrator internals for building a realistic audit export
      const { SqliteRunStateStore } = await import('@quarry-systems/agora-orchestrator');
      const { AuditLog } = await import('@quarry-systems/agora-orchestrator/src/audit/audit-log.js');
      const { LocalAnchor } = await import('@quarry-systems/agora-orchestrator/src/audit/anchor.js');

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
      const { SqliteRunStateStore } = await import('@quarry-systems/agora-orchestrator');
      const { AuditLog } = await import('@quarry-systems/agora-orchestrator/src/audit/audit-log.js');
      const { LocalAnchor } = await import('@quarry-systems/agora-orchestrator/src/audit/anchor.js');

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
      const { SqliteRunStateStore } = await import('@quarry-systems/agora-orchestrator');
      const { AuditLog } = await import('@quarry-systems/agora-orchestrator/src/audit/audit-log.js');
      const { LocalAnchor } = await import('@quarry-systems/agora-orchestrator/src/audit/anchor.js');

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

      const tmpDir = await mkdtemp(join(tmpdir(), 'agora-cli-audit-'));
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
});
