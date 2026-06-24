import { canonicalJsonString, computeContentHash } from '@quarry-systems/pangolin-core';
import type { Executor, ExecutionResult, FireContext, WorkItem } from '../contracts/index.js';
import { buildManifest } from '../audit/manifest.js';

/** A natural person's decision on a pending approval — the human-input "sentinel" payload. */
export interface ApprovalDecision {
  approver: string; // the deciding person's identity (sealed into evidence)
  decision: 'approve' | 'reject';
  decidedAt: string; // ISO-8601, supplied by the decision system (not invented here)
  reason?: string;
}

/** The pending request fire() opens — what is being approved, and by whom (role). */
export interface ApprovalRequest {
  approvalId: string; // == dispatchHash; stable across replays
  runId: string;
  subjectItemId: string; // the item whose product is under review
  approverRole: string; // the role required to decide
  requestedAt: string;
}

/** The out-of-band decision channel (a reviewer UI / Slack / email action / queue).
 *  `open` registers a pending request (idempotent); `poll` returns the human decision,
 *  or null until a natural person has decided. The pattern/engine never blocks — the
 *  engine polls reconcile() each tick, which polls here. */
export interface ApprovalSource {
  open?(request: ApprovalRequest): Promise<void> | void;
  poll(approvalId: string): Promise<ApprovalDecision | null> | ApprovalDecision | null;
}

/** Content-addressed sink for the sealed approval record (e.g. the run's storage/blob store). */
export interface ApprovalRecordSink {
  put(ref: string, bytes: Uint8Array): Promise<void> | void;
}

/** The immutable evidence sealed when a decision arrives — proves WHO approved, WHEN, of what. */
export interface ApprovalRecord {
  approvalId: string;
  runId: string;
  subjectItemId: string;
  approverRole: string;
  approver: string;
  decision: 'approve' | 'reject';
  decidedAt: string;
  reason?: string;
}

export interface HumanApprovalExecutorOptions {
  /** Executor id registered with the orchestrator. Default 'human-approval'. */
  id?: string;
  /** Where human decisions come from. */
  source: ApprovalSource;
  /** Where the sealed approval record is written (content-addressed). */
  sink: ApprovalRecordSink;
  /** Namespace prefix for the record ref. Default 'ns'. */
  namespace?: string;
}

/**
 * A reviewer Executor whose verdict is a NATURAL PERSON's decision — the oversight / four-eyes
 * tier of the quorum pattern. `fire()` opens a pending approval (the sentinel a human resolves
 * out of band) and never blocks; `reconcile()` returns null until a decision arrives, then
 * resolves `done` with `verify.passed` reflecting approve/reject and seals an immutable
 * approval record (approver identity + timestamp) referenced via `outputRefs.approval`.
 *
 * Drop it into a quorum reviewer slot to satisfy human-oversight controls (EU AI Act Art. 14,
 * segregation-of-duties / four-eyes) that an AI-only quorum cannot meet.
 */
export class HumanApprovalExecutor implements Executor {
  readonly id: string;
  private readonly pending = new Map<string, ApprovalRequest>();

  constructor(private readonly opts: HumanApprovalExecutorOptions) {
    this.id = opts.id ?? 'human-approval';
  }

  async fire(
    item: WorkItem,
    ctx?: FireContext,
  ): Promise<{ dispatchHash: string; manifestRef?: string }> {
    const approverRole =
      typeof item.inputs['approverRole'] === 'string'
        ? (item.inputs['approverRole'] as string)
        : 'approver';
    // The item under review is the producer this reviewer's work binds to (quorum sets needs.work
    // from the subject); fall back to the item id when no binding is present.
    const subjectItemId = item.needs?.['work']?.from ?? item.id;
    const runId = ctx?.runId ?? '';
    const requestedAt = new Date().toISOString();
    const approvalId = `appr-${runId}-${item.id}`;

    const request: ApprovalRequest = {
      approvalId,
      runId,
      subjectItemId,
      approverRole,
      requestedAt,
    };
    this.pending.set(approvalId, request);
    await this.opts.source.open?.(request);

    // The engine resolves needs.work → the subject's product and sets inputs.inputRefs before
    // fire. Sealing it binds the approval to the EXACT content-addressed artifact the person saw
    // (and lets provenance closure account for this reviewer's edge). Shape guard, not a trust
    // guard: keep only string values.
    const rawRefs = item.inputs['inputRefs'];
    const inputRefs =
      rawRefs && typeof rawRefs === 'object'
        ? (Object.fromEntries(
            Object.entries(rawRefs as Record<string, unknown>).filter(
              ([, v]) => typeof v === 'string',
            ),
          ) as Record<string, string>)
        : undefined;

    // Seal the REQUEST (authorized-before-it-ran flavor): proves the approval was solicited,
    // of which role, for which subject, before any human acted. Best-effort (mirrors DispatchExecutor).
    let manifestRef: string | undefined;
    try {
      const { bytes } = buildManifest({
        runId,
        itemId: item.id,
        executor: this.id,
        executorManifest: { kind: 'human-approval', approverRole, subjectItemId },
        secretRefs: [],
        actor: ctx?.actor ?? '',
        firedAt: requestedAt,
        submittedAt: ctx?.submittedAt,
        ...(inputRefs && Object.keys(inputRefs).length ? { inputRefs } : {}),
      });
      // computeContentHash already returns a `sha256:`-prefixed digest; the URI's last segment is
      // that digest verbatim (mirrors the dispatch/pattern-harness convention so verifyBundle's
      // content-address check binds it).
      manifestRef = `pangolin://${this.namespace}/manifest/m/${computeContentHash(bytes)}`;
      await this.opts.sink.put(manifestRef, bytes);
    } catch {
      manifestRef = undefined; // best-effort — the pending request is already registered
    }

    return { dispatchHash: approvalId, manifestRef };
  }

  async reconcile(dispatchHash: string): Promise<ExecutionResult | null> {
    const request = this.pending.get(dispatchHash);
    if (!request) return null; // unknown dispatch (or already settled)

    const decision = await this.opts.source.poll(dispatchHash);
    if (!decision) return null; // still pending — no natural person has decided yet

    this.pending.delete(dispatchHash);

    const record: ApprovalRecord = {
      approvalId: request.approvalId,
      runId: request.runId,
      subjectItemId: request.subjectItemId,
      approverRole: request.approverRole,
      approver: decision.approver,
      decision: decision.decision,
      decidedAt: decision.decidedAt,
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    };
    const bytes = new TextEncoder().encode(canonicalJsonString(record));
    const ref = `pangolin://${this.namespace}/approval/a/${computeContentHash(bytes)}`;
    await this.opts.sink.put(ref, bytes);

    const passed = decision.decision === 'approve';
    return {
      status: 'done', // the approval step completed; the verdict (approve/reject) is in `verify`
      output: {
        approver: decision.approver,
        decision: decision.decision,
        decidedAt: decision.decidedAt,
      },
      resultRef: ref,
      verify: {
        passed,
        report: `${decision.decision} by ${decision.approver} at ${decision.decidedAt}`,
      },
      outputRefs: { approval: ref },
    };
  }

  private get namespace(): string {
    return this.opts.namespace ?? 'ns';
  }
}
