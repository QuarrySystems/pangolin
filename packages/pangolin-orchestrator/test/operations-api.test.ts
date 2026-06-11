import { describe, it, expect } from 'vitest';
import { OperationsApi } from '../src/operations-api.js';
import type {
  SubmissionTransport,
  ControlChannel,
  ControlEnvelope,
  OutboxRecord,
  SubmissionEnvelope,
  AuditExport,
  AuditItemOutcome,
} from '../src/contracts/index.js';
import type { Run } from '../src/contracts/index.js';
import { SqliteRunStateStore } from '../src/runstate/sqlite.js';
import { AuditLog } from '../src/audit/audit-log.js';
import { LocalAnchor } from '../src/audit/anchor.js';

// ---------------------------------------------------------------------------
// Hand-built fake transport (in-memory, no DB)
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

const sampleRun: Run = {
  id: 'run-abc',
  queue: 'default',
  items: [
    { id: 'item-1', executor: 'noop', inputs: {}, depends_on: [], resourceLocks: [] },
  ],
};

// ---------------------------------------------------------------------------
// Helpers for audit test
// ---------------------------------------------------------------------------
const fakeSigner = { async sign() { return { alg: 'none', bytes: new Uint8Array(0) }; } };

async function buildAuditExport(runId: string): Promise<{
  exp: AuditExport;
  anchor: LocalAnchor;
  store: SqliteRunStateStore;
}> {
  const store = new SqliteRunStateStore();
  const anchor = new LocalAnchor(store);
  const log = new AuditLog({ store, signer: fakeSigner, anchor });

  log.append({ runId, kind: 'run.submitted', actor: 'human:test', at: '2026-06-01T00:00:00Z' });
  log.append({ runId, kind: 'run.completed', at: '2026-06-01T00:01:00Z' });
  await log.sealEpoch(runId);

  const entries = store.getAuditEntries(runId);
  const root = store.getAuditRoot(runId);
  const items: AuditItemOutcome[] = [{ id: 'item-1', status: 'done' }];
  const exp: AuditExport = { runId, entries, root, items };
  return { exp, anchor, store };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('OperationsApi', () => {
  describe('submit', () => {
    it('stamps actor + submittedAt and writes via transport (no DB)', async () => {
      const transport = makeFakeTransport();
      const fixedNow = '2026-06-01T12:00:00.000Z';
      const api = new OperationsApi({ transport, nowIso: () => fixedNow });

      const returnedId = await api.submit(sampleRun, 'human:brett');

      expect(returnedId).toBe('run-abc');
      expect(transport._submissions).toHaveLength(1);
      const env = transport._submissions[0];
      expect(env.actor).toBe('human:brett');
      expect(env.submittedAt).toBe(fixedNow);
      expect(env.run).toBe(sampleRun);
    });

    it('returns the run id from the transport', async () => {
      const transport = makeFakeTransport();
      const api = new OperationsApi({ transport });

      const id = await api.submit(sampleRun, 'agent:bot');
      expect(id).toBe('run-abc');
    });
  });

  describe('cancel', () => {
    it('writes a kind:cancel ControlEnvelope with actor and target', async () => {
      const transport = makeFakeTransport();
      const fixedNow = '2026-06-01T13:00:00.000Z';
      const api = new OperationsApi({ transport, nowIso: () => fixedNow });

      await api.cancel('run-1', 'human:brett');

      expect(transport._controls).toHaveLength(1);
      const env = transport._controls[0];
      expect(env.kind).toBe('cancel');
      expect(env.target).toBe('run-1');
      expect(env.actor).toBe('human:brett');
      expect(env.at).toBe(fixedNow);
    });
  });

  describe('status', () => {
    it('returns the latest status outbox record', async () => {
      const transport = makeFakeTransport();
      const api = new OperationsApi({ transport });

      // Seed outbox with two status records at different times
      const rec1: OutboxRecord = {
        runId: 'run-x', kind: 'status',
        body: [{ id: 'item-1', runId: 'run-x', status: 'running', blockedBy: [] }],
        at: '2026-06-01T10:00:00Z',
      };
      const rec2: OutboxRecord = {
        runId: 'run-x', kind: 'status',
        body: [{ id: 'item-1', runId: 'run-x', status: 'done', blockedBy: [] }],
        at: '2026-06-01T10:01:00Z',
      };
      await transport.publish(rec1);
      await transport.publish(rec2);

      const result = await api.status('run-x');
      expect(result).toBeDefined();
      // Should be the last status record (rec2)
      expect(result!.at).toBe('2026-06-01T10:01:00Z');
      expect((result!.body as Array<{ status: string }>)[0].status).toBe('done');
    });

    it('falls back to the latest record of any kind when no status record exists', async () => {
      const transport = makeFakeTransport();
      const api = new OperationsApi({ transport });

      const rec: OutboxRecord = {
        runId: 'run-y', kind: 'completed',
        body: { summary: 'all done' },
        at: '2026-06-01T11:00:00Z',
      };
      await transport.publish(rec);

      const result = await api.status('run-y');
      expect(result).toBeDefined();
      expect(result!.kind).toBe('completed');
    });

    it('returns undefined when the outbox is empty', async () => {
      const transport = makeFakeTransport();
      const api = new OperationsApi({ transport });

      const result = await api.status('run-empty');
      expect(result).toBeUndefined();
    });
  });

  describe('audit', () => {
    it('reads the latest audit outbox record body as AuditExport and returns a bundle', async () => {
      const transport = makeFakeTransport();
      const { exp, anchor } = await buildAuditExport('run-audit-1');

      const storage = {
        async get(_ref: string): Promise<Uint8Array> { throw new Error('no manifests'); },
      };

      const api = new OperationsApi({ transport, anchor, storage });

      // Publish an audit record whose body is the AuditExport
      const auditRec: OutboxRecord = {
        runId: 'run-audit-1', kind: 'audit', body: exp, at: '2026-06-01T12:00:00Z',
      };
      await transport.publish(auditRec);

      const bundle = await api.audit('run-audit-1');
      expect(bundle.runId).toBe('run-audit-1');
      expect(bundle.report.intact).toBe(true);
    });

    it('throws a clear error when anchor/storage are absent', async () => {
      const transport = makeFakeTransport();
      const api = new OperationsApi({ transport });

      await expect(api.audit('run-1')).rejects.toThrow('audit requires anchor + storage');
    });

    it('throws a clear error when no audit export has been published', async () => {
      const transport = makeFakeTransport();
      const { anchor } = await buildAuditExport('run-audit-2');
      const storage = {
        async get(_ref: string): Promise<Uint8Array> { throw new Error('no manifests'); },
      };

      const api = new OperationsApi({ transport, anchor, storage });

      // Publish only a status record (not an audit record)
      await transport.publish({ runId: 'run-audit-2', kind: 'status', body: [], at: '2026-06-01T00:00:00Z' });

      await expect(api.audit('run-audit-2')).rejects.toThrow('no audit export published');
    });

    it('throws the same clear error when the audit outbox body is malformed (a string)', async () => {
      const transport = makeFakeTransport();
      const { anchor } = await buildAuditExport('run-audit-3');
      const storage = {
        async get(_ref: string): Promise<Uint8Array> { throw new Error('no manifests'); },
      };

      const api = new OperationsApi({ transport, anchor, storage });

      // Publish an audit record whose body is a malformed string (not an AuditExport)
      await transport.publish({
        runId: 'run-audit-3', kind: 'audit', body: 'garbage', at: '2026-06-01T00:00:00Z',
      });

      await expect(api.audit('run-audit-3')).rejects.toThrow('no audit export published');
    });

    it('throws the same clear error when the audit outbox body is an object missing runId', async () => {
      const transport = makeFakeTransport();
      const { anchor } = await buildAuditExport('run-audit-4');
      const storage = {
        async get(_ref: string): Promise<Uint8Array> { throw new Error('no manifests'); },
      };

      const api = new OperationsApi({ transport, anchor, storage });

      // Publish an audit record whose body is an object but missing runId
      await transport.publish({
        runId: 'run-audit-4', kind: 'audit', body: { entries: [], root: null, items: [] }, at: '2026-06-01T00:00:00Z',
      });

      await expect(api.audit('run-audit-4')).rejects.toThrow('no audit export published');
    });
  });

  describe('watch', () => {
    it('yields status records and stops when all items are terminal', async () => {
      const transport = makeFakeTransport();
      let tick = 0;
      const api = new OperationsApi({
        transport,
        nowIso: () => new Date().toISOString(),
      });

      // Override readOutbox to return running on tick 0, then terminal on tick 1
      const originalReadOutbox = transport.readOutbox.bind(transport);
      transport.readOutbox = async (runId: string): Promise<OutboxRecord[]> => {
        tick++;
        if (tick === 1) {
          return [{
            runId, kind: 'status',
            body: [{ id: 'item-1', runId, status: 'running', blockedBy: [] }],
            at: '2026-06-01T10:00:00Z',
          }];
        }
        return [{
          runId, kind: 'status',
          body: [{ id: 'item-1', runId, status: 'done', blockedBy: [] }],
          at: '2026-06-01T10:01:00Z',
        }];
      };
      void originalReadOutbox; // suppress unused warning

      const records: OutboxRecord[] = [];
      for await (const rec of api.watch('run-watch-1', { intervalMs: 5 })) {
        records.push(rec);
      }

      expect(records.length).toBeGreaterThanOrEqual(2);
      // Last record should be terminal (done)
      const lastBody = records.at(-1)!.body as Array<{ status: string }>;
      expect(lastBody[0].status).toBe('done');
    });

    it('stops when the abort signal fires', async () => {
      const transport = makeFakeTransport();
      const api = new OperationsApi({ transport });

      // Always return running status so it never terminates on its own
      transport.readOutbox = async (runId: string): Promise<OutboxRecord[]> => [{
        runId, kind: 'status',
        body: [{ id: 'item-1', runId, status: 'running', blockedBy: [] }],
        at: new Date().toISOString(),
      }];

      const controller = new AbortController();
      let yieldCount = 0;

      const gen = api.watch('run-watch-abort', { intervalMs: 5, signal: controller.signal });
      for await (const _rec of gen) {
        yieldCount++;
        if (yieldCount >= 2) {
          controller.abort();
        }
      }

      // We aborted — generator should have stopped
      expect(yieldCount).toBeGreaterThanOrEqual(2);
    });

    it('handles empty outbox gracefully during poll', async () => {
      const transport = makeFakeTransport();
      let tick = 0;
      const api = new OperationsApi({ transport });

      transport.readOutbox = async (runId: string): Promise<OutboxRecord[]> => {
        tick++;
        if (tick >= 2) {
          return [{
            runId, kind: 'status',
            body: [{ id: 'item-1', runId, status: 'done', blockedBy: [] }],
            at: new Date().toISOString(),
          }];
        }
        return []; // empty on first tick
      };

      const records: OutboxRecord[] = [];
      for await (const rec of api.watch('run-watch-empty', { intervalMs: 5 })) {
        records.push(rec);
      }

      // Should have gotten at least the terminal record
      expect(records.length).toBeGreaterThanOrEqual(1);
      const lastBody = records.at(-1)!.body as Array<{ status: string }>;
      expect(lastBody[0].status).toBe('done');
    });
  });
});
