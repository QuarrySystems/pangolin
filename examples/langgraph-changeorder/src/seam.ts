// seam.ts — THE PANGOLIN SEAM.
//
// This is the entire integration. It is additive: the LangGraph agent in
// agent.ts is imported and driven UNCHANGED. The seam observes the agent's
// execution through the stock streaming API (`graph.stream(..., {streamMode:
// "updates"})`) and, for each node and for the human approval, appends a
// hash-chained, signed audit entry. Nothing is monkey-patched into the agent.
//
// What it produces is a real Pangolin AuditBundle — the same object
// examples/verify-tsa seals and a third party re-verifies with nothing but
// @quarry-systems/pangolin-verify.
//
// Real primitives used (no invented API surface):
//   AuditLog.append / .sealEpoch      — the hash chain + Merkle seal
//   buildManifest                     — per-node manifest + self-hash (SHA-256)
//   computeContentHash / canonicalJsonString — content addressing (SHA-256)
//   createLocalSigner / LocalAnchor / SqliteRunStateStore / assembleBundle

import { Command } from '@langchain/langgraph';
import {
  AuditLog,
  LocalAnchor,
  SqliteRunStateStore,
  assembleBundle,
  createLocalSigner,
  buildManifest,
} from '@quarry-systems/pangolin-orchestrator';
import { computeContentHash, canonicalJsonString } from '@quarry-systems/pangolin-core';
import type {
  AuditBundle,
  AuditItemOutcome,
  VerificationReport,
} from '@quarry-systems/pangolin-core';
import {
  buildChangeOrderAgent,
  type Approval,
  type ChangeOrder,
  type Outcome,
} from './agent.js';
import type { Decide } from './run-plain.js';

/** The immutable evidence sealed when a human decides — proves WHO approved,
 *  WHEN, of what, and the verdict. This shape mirrors Pangolin's own
 *  ApprovalRecord (packages/pangolin-orchestrator/src/executors/human-approval.ts).
 *
 *  TODO(pangolin): when Pangolin's run-engine drives the graph, this is produced
 *  by HumanApprovalExecutor.reconcile() instead of being assembled here. We
 *  replicate its sealing path (canonicalJsonString → computeContentHash →
 *  pangolin://ns/approval/a/<sha256>, referenced via outputRefs.approval) so the
 *  bundle is byte-compatible with that executor's output and the standard
 *  verifier's handoff/manifest checks bind it without modification. */
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

export interface ProvenanceResult {
  /** The agent's ordinary outcome — identical to what run-plain.ts returns. */
  outcome: Outcome;
  /** The assembled, verifiable bundle (binary fields are still raw Uint8Array). */
  bundle: AuditBundle;
  /** The sealed human-approval record (the auditor recomputes its hash). */
  approvalRecord: ApprovalRecord;
  /** Reference the approval was sealed under: pangolin://ns/approval/a/<sha256>. */
  approvalRef: string;
  /** The signer's SPKI-DER public key (base64) for the verify-context. */
  signerPublicKeyB64: string;
  /** The bundle's own seal-time verification report (a self-check). */
  report: VerificationReport;
}

export interface SeamOptions {
  namespace?: string;
  actor?: string;
  /** Clock seam — injectable so tests can produce a deterministic bundle. */
  now?: () => string;
}

/**
 * Run the change-order agent with Pangolin provenance. The agent is driven
 * exactly as run-plain.ts drives it; the only additions are the audit appends.
 */
export async function withProvenance(
  changeOrder: ChangeOrder,
  decide: Decide,
  opts: SeamOptions = {},
): Promise<ProvenanceResult> {
  const namespace = opts.namespace ?? 'changeorder';
  const actor = opts.actor ?? 'agent:langgraph-changeorder';
  const now = opts.now ?? (() => new Date().toISOString());
  const runId = changeOrder.id;

  // Real Pangolin audit stack: in-memory store, local signer, local anchor.
  const store = new SqliteRunStateStore(':memory:');
  const signer = createLocalSigner('changeorder-demo-signer');
  const anchor = new LocalAnchor(store);
  const log = new AuditLog({ store, signer, anchor });

  // Content-addressed blob store for the per-node manifests + the approval record.
  const blobs = new Map<string, Uint8Array>();
  const items: AuditItemOutcome[] = [];

  /** Seal one node: build + store its manifest, then chain item.fired + item.reconciled. */
  function sealNode(
    itemId: string,
    executorManifest: unknown,
    extra: { inputRefs?: Record<string, string>; resultRef?: string; outputRefs?: Record<string, string> } = {},
  ): void {
    const firedAt = now();
    const { manifest, bytes } = buildManifest({
      runId,
      itemId,
      executor: `langgraph:${itemId}`,
      executorManifest,
      secretRefs: [],
      actor,
      firedAt,
      ...(extra.inputRefs ? { inputRefs: extra.inputRefs } : {}),
    });
    const manifestRef = `pangolin://${namespace}/manifest/${itemId}/${manifest.manifestHash}`;
    blobs.set(manifestRef, bytes);
    log.append({ runId, kind: 'item.fired', itemId, manifestRef, actor, at: firedAt });
    log.append({
      runId,
      kind: 'item.reconciled',
      itemId,
      status: 'done',
      at: now(),
      ...(extra.resultRef ? { resultRef: extra.resultRef } : {}),
      ...(extra.outputRefs ? { outputRefs: extra.outputRefs } : {}),
    });
    items.push({
      id: itemId,
      status: 'done',
      manifestRef,
      ...(extra.resultRef ? { resultRef: extra.resultRef } : {}),
      ...(extra.outputRefs ? { outputRefs: extra.outputRefs } : {}),
    });
  }

  const agent = buildChangeOrderAgent();
  const config = { configurable: { thread_id: runId }, streamMode: 'updates' as const };

  log.append({ runId, kind: 'run.submitted', actor, at: now() });

  // ── Pass 1: drive the agent until the approval interrupt suspends it. ──
  let request: unknown;
  for await (const chunk of await agent.stream({ changeOrder }, config)) {
    const rec = chunk as Record<string, unknown>;
    if (rec.__interrupt__) {
      request = (rec.__interrupt__ as Array<{ value: unknown }>)[0]?.value;
      continue;
    }
    const [node, update] = Object.entries(rec)[0] as [string, Record<string, unknown>];
    if (node === 'ingest') sealNode('ingest', { kind: 'ingest', changeOrderId: runId });
    else if (node === 'assess') sealNode('assess', { kind: 'assess', assessment: update.assessment });
  }
  if (request === undefined) throw new Error('expected the agent to pause at the approval gate');

  // ── Seal the human approval — the highest-leverage step. ──
  // A plain LangGraph interrupt just pauses and resumes. Here the SAME decision
  // is sealed into the provenance record: canonical-JSON → SHA-256 → a
  // content-addressed pangolin:// ref, bound into the hash chain below.
  const approval: Approval = await decide(request);
  const approvalRecord: ApprovalRecord = {
    approvalId: `appr-${runId}-approvalGate`,
    runId,
    subjectItemId: 'assess',
    approverRole: 'project-director',
    approver: approval.approver,
    decision: approval.decision,
    decidedAt: approval.decidedAt,
    ...(approval.reason !== undefined ? { reason: approval.reason } : {}),
  };
  const approvalBytes = new TextEncoder().encode(canonicalJsonString(approvalRecord));
  const approvalRef = `pangolin://${namespace}/approval/a/${computeContentHash(approvalBytes)}`;
  blobs.set(approvalRef, approvalBytes);

  // ── Pass 2: resume with the decision; seal the remaining nodes. ──
  let outcome: Outcome | undefined;
  for await (const chunk of await agent.stream(new Command({ resume: approval }), config)) {
    const [node, update] = Object.entries(chunk as Record<string, unknown>)[0] as [
      string,
      Record<string, unknown>,
    ];
    if (node === 'approvalGate') {
      // Bind the sealed approval record INTO the chain via outputRefs.approval —
      // exactly how HumanApprovalExecutor.reconcile() seals it.
      sealNode(
        'approvalGate',
        { kind: 'human-approval', approverRole: 'project-director', subjectItemId: 'assess' },
        { resultRef: approvalRef, outputRefs: { approval: approvalRef } },
      );
    } else if (node === 'finalize') {
      // finalize CONSUMES the approval (inputRefs) — so provenance closure binds
      // the outcome to the sealed decision. Strip or alter the approval and the
      // handoff check fails: the approval is non-optional, not a side note.
      outcome = update.outcome as Outcome;
      sealNode('finalize', { kind: 'finalize', outcome }, { inputRefs: { approval: approvalRef } });
    }
  }
  if (!outcome) throw new Error('agent finished without an outcome');

  // ── Seal the epoch: Merkle root over the chain, signed + anchored. ──
  log.append({ runId, kind: 'run.completed', actor, at: now() });
  await log.sealEpoch(runId);

  const exp = {
    runId,
    entries: store.getAuditEntries(runId),
    root: store.getAuditRoot(runId),
    items,
  };
  const storage = {
    async get(ref: string): Promise<Uint8Array> {
      const b = blobs.get(ref);
      if (!b) throw new Error(`seam storage: no blob for ${ref}`);
      return b;
    },
  };
  const bundle = await assembleBundle(exp, { anchor, storage });

  return {
    outcome,
    bundle,
    approvalRecord,
    approvalRef,
    signerPublicKeyB64: signer.publicKey.toString('base64'),
    report: bundle.report,
  };
}
