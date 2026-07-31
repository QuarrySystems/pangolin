// The rule VERIFICATION.md states — "the verifier recomputes `report` from scratch; it
// does not trust the embedded one" — is only worth as much as the code that honours it.
// It was broken once: `orch watch` rendered, and `orch audit` set its EXIT CODE from, the
// report embedded by assembleBundle, which carried no manifest-integrity result, so a
// forged manifest passed those paths clean (KNOWN-ISSUES #5).
//
// These tests pin the property in its sharpest form: a bundle carrying a report that
// says everything is fine must not be believed.
import { describe, it, expect } from 'vitest';
import type { AuditAnchor, AuditBundle } from '@quarry-systems/pangolin-orchestrator';
import { recomputeVerdict, verifiedView } from '../src/verified-bundle.js';

/** An anchor that has never heard of this run — so a recomputed verdict cannot be intact. */
const emptyAnchor: AuditAnchor = {
  id: 'test-anchor',
  guarantee: 'external-immutable',
  async anchor() {
    return { anchorId: 'test-anchor', epochId: 'r', guarantee: 'external-immutable', at: 0 };
  },
  async fetch() {
    return [];
  },
};

/** A bundle whose embedded report is a flat lie: it claims a verified, tamper-evident run. */
function bundleWithLyingReport(): AuditBundle {
  return {
    runId: 'r',
    manifests: [],
    items: [],
    auditLog: { entries: [] },
    report: {
      runId: 'r',
      anchorId: 'test-anchor',
      guarantee: 'external-immutable',
      intact: true,
      claim: 'tamper-evident',
      checks: {
        chain: { ok: true },
        root: { ok: true },
        signature: { ok: true },
        anchor: { ok: true },
        handoff: { ok: true, detail: '99 input refs accounted for' },
      },
    },
  } as unknown as AuditBundle;
}

describe('recomputeVerdict', () => {
  it('ignores the embedded report entirely', async () => {
    const report = await recomputeVerdict(bundleWithLyingReport(), { anchor: emptyAnchor }, 'test');

    // The bundle SAYS intact/tamper-evident. The anchor knows nothing about this run.
    expect(report.intact).toBe(false);
    expect(report.claim).not.toBe('tamper-evident');
    expect(report.checks.anchor.ok).toBe(false);
  });

  it('throws rather than returning a reassuring verdict when no anchor is configured', async () => {
    // A verdict with nothing to anchor against is not a weaker verdict; it is not a
    // verdict. Failing loudly beats printing something that looks like a pass.
    await expect(recomputeVerdict(bundleWithLyingReport(), {}, 'orch audit')).rejects.toThrow(
      /orch audit.*no anchor/i,
    );
  });
});

describe('verifiedView', () => {
  it('replaces the embedded report, so a renderer cannot show the lie', async () => {
    // renderVerification reads bundle.report — handing it the original bundle is exactly
    // how the lie would reach an operator's screen.
    const { bundle, report } = await verifiedView(
      bundleWithLyingReport(),
      { anchor: emptyAnchor },
      'test',
    );

    expect(bundle.report).toBe(report);
    expect(bundle.report.intact).toBe(false);
    expect(bundle.report.checks.handoff).not.toEqual({
      ok: true,
      detail: '99 input refs accounted for',
    });
  });

  it('leaves the caller-supplied bundle untouched', async () => {
    // Non-mutating: the input keeps its own (untrusted) report, so nothing is laundered
    // in place and a caller holding the original still knows it is unverified.
    const original = bundleWithLyingReport();
    await verifiedView(original, { anchor: emptyAnchor }, 'test');
    expect(original.report.intact).toBe(true);
  });
});
