// packages/pangolin-orchestrator/src/operations-api.ts
// §10.2 — consolidated client-facing operations surface.
// MUST NOT import or reference: store, SqliteRunStateStore, tick, any DB type,
// subagent, model, dispatch, or claude.  Client-only (D3).

import type {
  SubmissionTransport,
  ControlChannel,
  ControlEnvelope,
  OutboxRecord,
  Run,
  AuditAnchor,
  AuditBundle,
  AuditExport,
  Signature,
} from './contracts/index.js';
import { assembleBundle } from './audit/bundle.js';

interface StorageLike { get(ref: string): Promise<Uint8Array>; }

export interface OperationsApiDeps {
  transport: SubmissionTransport & ControlChannel;
  anchor?: AuditAnchor;
  storage?: StorageLike;
  verifySignature?: (root: Uint8Array, sig: Signature) => boolean;
  nowIso?: () => string;
}

/** Terminal item statuses — a run is done when every item is in one of these. */
const TERMINAL_ITEM_STATUSES = new Set(['done', 'failed', 'skipped', 'cancelled']);

/** Resolves after `ms` milliseconds, or immediately if the signal is already aborted or fires.
 *  Mirrors serve/driver.ts's sleep — kept minimal, no timers beyond setTimeout. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Determine if a status OutboxRecord's body represents a terminal run.
 *  The body is the array of StatusItems published by serve/driver.ts via
 *  getStatus() — each has a `status` string field.  A run is terminal when
 *  every item's status ∈ {done, failed, skipped, cancelled}. */
function isTerminalStatusBody(body: unknown): boolean {
  if (!Array.isArray(body) || body.length === 0) return false;
  return (body as Array<{ status?: string }>).every(
    (item) => typeof item.status === 'string' && TERMINAL_ITEM_STATUSES.has(item.status),
  );
}

export class OperationsApi {
  constructor(private readonly deps: OperationsApiDeps) {}

  /** Submit a run; captures actor + submittedAt (§6.4). Returns the run id. Opens NO DB. */
  async submit(run: Run, actor: string): Promise<string> {
    return this.deps.transport.submit({ run, actor, submittedAt: this.now() });
  }

  /** Return the latest status outbox record for a run; falls back to the latest record of any kind. */
  async status(runId: string): Promise<OutboxRecord | undefined> {
    const latest = await this.readLatest(runId, 'status');
    return latest ?? (await this.readLatest(runId));
  }

  /** One record off the outbox, via the transport's reverse-scan fast path when it has
   *  one and a full read when it does not (readLatestOutbox is optional on the contract).
   *
   *  This is the whole of the read-cost fix: status(), audit() and watch() each want a
   *  single record, and reading the run's entire outbox to find it made every client read
   *  scale with how long the stack had been up rather than with the run. */
  private async readLatest(
    runId: string,
    kind?: OutboxRecord['kind'],
  ): Promise<OutboxRecord | undefined> {
    const t = this.deps.transport;
    if (t.readLatestOutbox) return t.readLatestOutbox(runId, kind);
    const recs = await t.readOutbox(runId);
    return kind === undefined ? recs.at(-1) : recs.filter((r) => r.kind === kind).at(-1);
  }

  /** Send a cancel control envelope for a target run or item; captures actor (§6.4). */
  async cancel(target: string, actor: string): Promise<void> {
    const env: ControlEnvelope = { kind: 'cancel', target, actor, at: this.now() };
    await this.deps.transport.control(env);
  }

  /** Assemble and return the tamper-evident audit bundle for a sealed run.
   *  Requires anchor + storage in the orch context.  Throws clearly if absent or if no
   *  audit export has been published yet. */
  async audit(runId: string): Promise<AuditBundle> {
    if (!this.deps.anchor || !this.deps.storage) {
      throw new Error('audit requires anchor + storage in the orch context');
    }
    const rawBody = (await this.readLatest(runId, 'audit'))?.body;
    if (
      rawBody === null || rawBody === undefined ||
      typeof rawBody !== 'object' ||
      typeof (rawBody as Record<string, unknown>).runId !== 'string'
    ) {
      throw new Error(`no audit export published yet for run ${runId}`);
    }
    const exp = rawBody as AuditExport;
    return assembleBundle(exp, {
      anchor: this.deps.anchor,
      storage: this.deps.storage,
      verifySignature: this.deps.verifySignature,
    });
  }

  /** Poll status until the run is terminal (v1 polling model — NO streaming).
   *  Yields each non-empty status record; stops when terminal or the signal fires.
   *  The caller controls cadence via intervalMs (default 2000 ms). */
  async *watch(
    runId: string,
    opts?: { intervalMs?: number; signal?: AbortSignal },
  ): AsyncGenerator<OutboxRecord> {
    const intervalMs = opts?.intervalMs ?? 2000;
    const signal = opts?.signal;

    while (!signal?.aborted) {
      const rec = await this.status(runId);

      if (rec !== undefined) {
        yield rec;
        if (rec.kind === 'status' && isTerminalStatusBody(rec.body)) {
          return;
        }
      }

      await sleep(intervalMs, signal);
    }
  }

  private now(): string { return this.deps.nowIso?.() ?? new Date().toISOString(); }
}
