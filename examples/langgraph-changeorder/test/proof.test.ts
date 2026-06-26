// proof.test.ts — the acceptance proof, $0 / offline.
//
// Proves all five acceptance criteria:
//   1. the LangGraph agent runs standalone with the seam removed
//   2. the seam produces a bundle the standalone verifier confirms (real SHA-256)
//   3. the human approval is sealed into the bundle and the verifier checks it
//   4. tampering one field post-hoc demonstrably fails verification
//   5. (covered by 2/3) no second orchestrator, no UI

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlain, SAMPLE_CHANGE_ORDER } from '../src/run-plain.js';
import { sealChangeOrder } from '../src/run-sealed.js';
import { verifyChangeOrder } from '../src/verify.js';

const approve = () =>
  ({
    approver: 'human:dana.okafor (Project Director)',
    decision: 'approve' as const,
    decidedAt: '2026-06-25T16:40:00.000Z',
    reason: 'Corrosion finding is material; substitution is the lowest-risk remedy.',
  });

/** Seal a fresh run and write the three auditor artifacts into `dir`. */
async function emit(dir: string) {
  const { bundleJson, contextJson, approvalJson } = await sealChangeOrder(SAMPLE_CHANGE_ORDER, approve);
  const bundlePath = join(dir, 'bundle.json');
  const contextPath = join(dir, 'verify-context.json');
  const approvalPath = join(dir, 'approval.json');
  await writeFile(bundlePath, JSON.stringify(bundleJson, null, 2));
  await writeFile(contextPath, JSON.stringify(contextJson, null, 2));
  await writeFile(approvalPath, JSON.stringify(approvalJson, null, 2));
  return { bundlePath, contextPath, approvalPath, bundleJson, approvalJson };
}

describe('langgraph-changeorder provenance seam', () => {
  it('criterion 1: the agent runs standalone with the seam removed', async () => {
    const outcome = await runPlain(SAMPLE_CHANGE_ORDER, approve);
    expect(outcome.outcome).toBe('APPROVED');
    expect(outcome.changeOrderId).toBe('CO-2026-0417');
    expect(outcome.approver).toContain('dana.okafor');
  });

  it('criterion 2: the sealed run verifies with real SHA-256', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'co-ok-'));
    const { bundlePath, contextPath, approvalPath } = await emit(dir);
    const { report, ok } = await verifyChangeOrder({ bundlePath, contextPath, approvalPath });
    expect(ok).toBe(true);
    expect(report.intact).toBe(true);
    expect(report.checks.chain.ok).toBe(true);
    expect(report.checks.root.ok).toBe(true);
    expect(report.checks.signature.ok).toBe(true); // ed25519 verified
    expect(report.checks.handoff.ok).toBe(true); // finalize consumes the sealed approval
    expect(report.failure).toBeUndefined(); // includes manifest-integrity (folded into failure)
    expect(report.claim).toBe('tamper-detecting'); // local anchor; S3 object-lock → tamper-evident
  });

  it('criterion 3: the human approval is sealed and the verifier checks it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'co-appr-'));
    const { bundlePath, contextPath, approvalPath } = await emit(dir);
    const { approval } = await verifyChangeOrder({ bundlePath, contextPath, approvalPath });
    expect(approval.ok).toBe(true);
    expect(approval.decision).toBe('approve');
    expect(approval.approver).toContain('dana.okafor');
  });

  it('criterion 4a: mutating a chain field (an entry timestamp) is rejected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'co-tamper-chain-'));
    const { bundleJson } = await emit(dir);
    // Post-hoc tamper: rewrite ONE entry's timestamp, leaving its entryHash stale.
    const tampered = structuredClone(bundleJson) as { auditLog: { entries: Array<{ at: string }> } };
    tampered.auditLog.entries[2].at = '2030-01-01T00:00:00.000Z';
    const bundlePath = join(dir, 'bundle.tampered.json');
    const contextPath = join(dir, 'verify-context.json');
    const approvalPath = join(dir, 'approval.json');
    await writeFile(bundlePath, JSON.stringify(tampered, null, 2));
    const { report, ok } = await verifyChangeOrder({ bundlePath, contextPath, approvalPath });
    expect(ok).toBe(false);
    expect(report.intact).toBe(false);
    expect(report.checks.chain.ok).toBe(false);
  });

  it('criterion 4b: swapping the sealed approval decision is rejected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'co-tamper-appr-'));
    const { approvalJson } = await emit(dir);
    // Post-hoc tamper: flip approve → reject in the sealed approval record.
    const tampered = structuredClone(approvalJson) as Record<string, unknown>;
    tampered.decision = 'reject';
    const bundlePath = join(dir, 'bundle.json');
    const contextPath = join(dir, 'verify-context.json');
    const approvalPath = join(dir, 'approval.tampered.json');
    await writeFile(approvalPath, JSON.stringify(tampered, null, 2));
    const { approval, ok } = await verifyChangeOrder({ bundlePath, contextPath, approvalPath });
    expect(ok).toBe(false);
    expect(approval.ok).toBe(false);
    expect(approval.detail).toMatch(/does not hash to the sealed ref/);
  });
});
