import { describe, it, expect } from 'vitest';
import type { AuditBundle, VerificationReport } from '@quarry-systems/pangolin-core';
import { renderVerification } from '../src/render.js';

/** Minimal bundle whose only interesting content is the report — render reads report + entries. */
function bundleWith(report: VerificationReport): AuditBundle {
  return {
    runId: report.runId,
    manifests: [],
    auditLog: {
      entries: [
        {
          runId: report.runId,
          seq: 0,
          kind: 'run.submitted',
          at: 't0',
          entryHash: 'abc123',
          prevHash: '',
        },
      ],
      root: undefined,
    },
    items: [],
    report,
  };
}

const baseChecks = {
  chain: { ok: true as const },
  root: { ok: true as const },
  signature: { ok: 'n/a' as const },
  anchor: { ok: true as const },
  handoff: { ok: true as const },
  time: { ok: 'n/a' as const },
};

describe('renderVerification — manifest-integrity check is surfaced', () => {
  it('renders a manifest ✗ line and a TAMPERED verdict when failure is manifest', () => {
    const report: VerificationReport = {
      runId: 'r',
      intact: false,
      anchorId: 'fake',
      guarantee: 'external-immutable',
      claim: 'tamper-detecting',
      timeTier: 'asserted',
      failure: 'manifest',
      checks: baseChecks,
    };
    const out = renderVerification(bundleWith(report));
    // The breakdown must explain WHY it is tampered — not show every listed check as ✓.
    expect(out).toContain('manifest');
    expect(out).toContain('✗ TAMPERED');
    // The manifest line itself must carry the ✗ marker.
    const manifestLine = out.split('\n').find((l) => l.includes('manifest'));
    expect(manifestLine).toBeDefined();
    expect(manifestLine).toContain('✗');
  });
});
