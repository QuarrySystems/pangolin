// verify.ts — the STANDALONE auditor. Independent of the agent and the seam.
//
// It takes only the three emitted JSON files and re-confirms integrity from
// scratch. It imports the Pangolin VERIFICATION library (pangolin-verify, plus
// pangolin-core's hashing) — never the orchestrator/agent that produced the
// bundle. That separation is the point: an auditor who never saw the run can
// re-derive every hash and reject any tampering.
//
//   pnpm --filter langgraph-changeorder-example verify
//
// Two layers of checking:
//   1. verifyBundle()        — recompute the per-entry SHA-256 chain, the Merkle
//                              root vs the anchored root, the signature, handoff
//                              closure, and manifest integrity.
//   2. checkApprovalSeal()   — recompute the human-approval record's content hash
//                              and confirm it equals the ref sealed in the chain,
//                              and that `finalize` consumes it. This is what makes
//                              the approval cryptographic evidence, not just a gate.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  loadBundle,
  loadVerifyContext,
  buildAnchor,
  makeVerifySignature,
  renderVerification,
  verifyBundle,
  type AuditBundle,
  type VerificationReport,
} from '@quarry-systems/pangolin-verify';
import { computeContentHash, canonicalJsonString } from '@quarry-systems/pangolin-core';

export interface ApprovalSealCheck {
  ok: boolean;
  detail: string;
  approver?: string;
  decision?: string;
  decidedAt?: string;
}

/**
 * Recompute the human-approval record's content hash and confirm it matches the
 * ref sealed into the tamper-anchored chain — and that `finalize` consumed it.
 *
 * A mutated approval.json hashes to a different ref → mismatch → rejected.
 * A mutated chained ref breaks the Merkle root → verifyBundle rejects it.
 * Either way the approval cannot be forged or detached after the fact.
 */
export function checkApprovalSeal(bundle: AuditBundle, approvalRecord: unknown): ApprovalSealCheck {
  // The auditor recomputes the seal from the record bytes — NOT from anything the
  // bundle asserts about it.
  const bytes = new TextEncoder().encode(canonicalJsonString(approvalRecord));
  const recomputedHash = computeContentHash(bytes); // sha256:<hex>

  // Find the approval ref sealed in the chain (item.reconciled.outputRefs.approval).
  const sealed = bundle.auditLog.entries.find(
    (e) => e.kind === 'item.reconciled' && e.outputRefs?.approval,
  );
  const chainedRef = sealed?.outputRefs?.approval;
  if (!chainedRef) return { ok: false, detail: 'no approval ref is sealed into the audit chain' };

  if (!chainedRef.endsWith(`/${recomputedHash}`)) {
    return {
      ok: false,
      detail: `approval record does not hash to the sealed ref (recomputed ${recomputedHash}, chain has ${chainedRef})`,
    };
  }

  // Confirm the outcome actually CONSUMES the approval (provenance closure).
  const finalize = bundle.manifests.find((m) => m.itemId === 'finalize');
  if (finalize?.inputRefs?.approval !== chainedRef) {
    return { ok: false, detail: 'finalize does not consume the sealed approval ref' };
  }

  const rec = approvalRecord as { approver?: string; decision?: string; decidedAt?: string };
  return {
    ok: true,
    detail: `approval sealed and consumed (${chainedRef})`,
    approver: rec.approver,
    decision: rec.decision,
    decidedAt: rec.decidedAt,
  };
}

export interface ChangeOrderVerification {
  report: VerificationReport;
  approval: ApprovalSealCheck;
  /** Overall pass: the bundle is intact AND the approval seal holds. */
  ok: boolean;
}

/** Re-verify a sealed change-order bundle as a standalone auditor. */
export async function verifyChangeOrder(paths: {
  bundlePath: string;
  contextPath: string;
  approvalPath: string;
}): Promise<ChangeOrderVerification> {
  const bundle = await loadBundle(paths.bundlePath);
  const ctx = await loadVerifyContext(paths.contextPath);
  const anchor = buildAnchor(ctx, bundle);
  const report = await verifyBundle(bundle, { anchor, verifySignature: makeVerifySignature(ctx) });

  const approvalRecord = JSON.parse(await readFile(paths.approvalPath, 'utf8'));
  const approval = checkApprovalSeal(bundle, approvalRecord);

  return { report, approval, ok: report.intact && approval.ok };
}

// Direct-invocation guard (ESM): true only when run as `tsx src/verify.ts`.
const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const bundlePath = process.argv[2] ?? './out/bundle.json';
  const contextPath = process.argv[3] ?? './out/verify-context.json';
  const approvalPath = process.argv[4] ?? './out/approval.json';
  verifyChangeOrder({ bundlePath, contextPath, approvalPath })
    .then(async ({ report, approval, ok }) => {
      const bundle = await loadBundle(bundlePath);
      console.log(renderVerification({ ...bundle, report }, { color: process.stdout.isTTY === true }));
      console.log(
        `\napproval seal: ${approval.ok ? 'OK' : 'FAILED'} — ${approval.detail}` +
          (approval.ok ? `\n  ${approval.decision} by ${approval.approver} at ${approval.decidedAt}` : ''),
      );
      console.log(`\noverall: ${ok ? 'VERIFIED ✓' : 'REJECTED ✗'}`);
      process.exitCode = ok ? 0 : 1;
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
