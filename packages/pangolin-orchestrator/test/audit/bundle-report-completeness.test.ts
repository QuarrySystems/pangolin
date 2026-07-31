// Regression tests for KNOWN-ISSUES.md #5 — "orch watch's inline verify under-reports
// against pangolin verify".
//
// DIAGNOSIS (the write-up left this open, and guessed wrong about it). The two paths do
// not differ in the DATA available to them — assembleBundle fetches the manifests into
// bundle.manifests, so everything needed is present. They differ in WHICH REPORT they
// render:
//
//   pangolin verify  -> verifyBundle(bundle, deps), then renders `{...bundle, report}`
//                       (cmd-verify.ts) — a freshly RECOMPUTED report.
//   orch watch       -> renderVerification(bundle) (cmd-orch.ts) — the report EMBEDDED
//                       in the bundle by assembleBundle.
//
// And assembleBundle builds that embedded report with verify(), the chain/store-only
// verifier, which computes chain + root + signature + anchor and NOTHING ELSE. It
// hardcodes `handoff: { ok: 'n/a' }` and never sets authzTier. Three checks that only
// verifyBundle performs are therefore absent from every embedded report:
//
//   1. handoff closure   — reported as a bare 'n/a' even when edges exist and pass
//   2. authorization tier — omitted entirely, so the row never renders
//   3. MANIFEST INTEGRITY — the manifest<->chain content binding
//
// (3) is the one that matters. It is a tamper check, and its absence is a FALSE
// NEGATIVE, not an under-claim: a bundle whose manifests are forged renders
// `✓ TAMPER-EVIDENT` through the embedded report while verifyBundle reports
// `✗ TAMPERED` with failure 'manifest'.
//
// The blast radius is wider than `watch`, because the embedded report is what several
// callers GATE on — `orch audit` sets its exit code from `bundle.report.intact`
// (cmd-orch.ts), as do examples/appendable-stream and examples/demo-claims-appeals.
//
// The fix is at the source: assembleBundle embeds the FULL report.
import { describe, it, expect } from 'vitest';
import { SqliteRunStateStore } from '../../src/runstate/sqlite.js';
import { AuditLog } from '../../src/audit/audit-log.js';
import { LocalAnchor } from '../../src/audit/anchor.js';
import { assembleBundle } from '../../src/audit/bundle.js';
import { verifyBundle } from '../../src/audit/verify-bundle.js';
import { computeContentHash } from '@quarry-systems/pangolin-core';
import type { AuditExport, DispatchManifest } from '../../src/contracts/index.js';

const fakeSigner = {
  async sign() {
    return { alg: 'none', bytes: new Uint8Array(0) };
  },
};

/** A produced artifact ref that a downstream manifest consumes — one real handoff edge. */
const PRODUCED = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** Build a manifest whose self-hash is correct, plus the PINNED ref that commits to it. */
function pinnedManifest(
  itemId: string,
  inputRefs?: Record<string, string>,
): { manifest: DispatchManifest; ref: string } {
  const base = {
    schemaVersion: 1 as const,
    runId: 'run-5',
    itemId,
    parent: 'run:run-5',
    executor: 'dispatch',
    executorManifest: {},
    secretRefs: [],
    actor: 'human:test',
    firedAt: '2026-06-01T00:01:00Z',
    ...(inputRefs ? { inputRefs } : {}),
  };
  const manifestHash = computeContentHash(base);
  return {
    manifest: { ...base, manifestHash } as DispatchManifest,
    ref: `pangolin://test/manifests/${itemId}/${manifestHash}`,
  };
}

/** Sealed two-item run: `a` produces PRODUCED, `b` consumes it via inputRefs. */
async function buildBundle(opts: { forgeManifest?: boolean } = {}) {
  const store = new SqliteRunStateStore();
  const anchor = new LocalAnchor(store);
  const log = new AuditLog({ store, signer: fakeSigner, anchor });

  const a = pinnedManifest('item-a');
  const b = pinnedManifest('item-b', { patch: PRODUCED });

  log.append({
    runId: 'run-5',
    kind: 'run.submitted',
    actor: 'human:test',
    at: '2026-06-01T00:00:00Z',
  });
  log.append({
    runId: 'run-5',
    kind: 'item.fired',
    itemId: 'item-a',
    manifestRef: a.ref,
    at: '2026-06-01T00:01:00Z',
  });
  log.append({
    runId: 'run-5',
    kind: 'item.reconciled',
    itemId: 'item-a',
    status: 'done',
    resultRef: PRODUCED,
    at: '2026-06-01T00:02:00Z',
  });
  log.append({
    runId: 'run-5',
    kind: 'item.fired',
    itemId: 'item-b',
    manifestRef: b.ref,
    at: '2026-06-01T00:03:00Z',
  });
  log.append({
    runId: 'run-5',
    kind: 'item.reconciled',
    itemId: 'item-b',
    status: 'done',
    at: '2026-06-01T00:04:00Z',
  });
  log.append({ runId: 'run-5', kind: 'run.completed', at: '2026-06-01T00:05:00Z' });
  await log.sealEpoch('run-5');

  const exp: AuditExport = {
    runId: 'run-5',
    entries: store.getAuditEntries('run-5'),
    root: store.getAuditRoot('run-5'),
    items: [
      { id: 'item-a', status: 'done', manifestRef: a.ref, resultRef: PRODUCED },
      { id: 'item-b', status: 'done', manifestRef: b.ref },
    ],
  };

  // The forgery mutates a manifest body AFTER its self-hash was sealed into the chain,
  // which is exactly what the manifest-integrity binding exists to catch.
  const served: Record<string, DispatchManifest> = {
    [a.ref]: opts.forgeManifest ? { ...a.manifest, executor: 'evil-executor' } : a.manifest,
    [b.ref]: b.manifest,
  };
  const storage = {
    async get(ref: string): Promise<Uint8Array> {
      const m = served[ref];
      if (!m) throw new Error(`unknown ref ${ref}`);
      return new TextEncoder().encode(JSON.stringify(m));
    },
  };

  const bundle = await assembleBundle(exp, { anchor, storage });
  return { bundle, anchor, store };
}

describe('#5 the report embedded by assembleBundle must be the full report', () => {
  it('reports handoff closure, not a bare n/a, when edges exist and pass', async () => {
    const { bundle, store } = await buildBundle();
    expect(bundle.report.checks.handoff).toEqual({
      ok: true,
      detail: '1 input ref accounted for',
    });
    store.close();
  });

  it('carries the authorization tier so the row can render', async () => {
    const { bundle, store } = await buildBundle();
    expect(bundle.report.authzTier).toBeDefined();
    store.close();
  });

  it('agrees with pangolin verify on the same bundle, check for check', async () => {
    // The contract in one line: the two paths must not disagree.
    const { bundle, anchor, store } = await buildBundle();
    const recomputed = await verifyBundle(bundle, { anchor });

    expect(bundle.report.checks).toEqual(recomputed.checks);
    expect(bundle.report.intact).toBe(recomputed.intact);
    expect(bundle.report.claim).toBe(recomputed.claim);
    expect(bundle.report.authzTier).toBe(recomputed.authzTier);
    store.close();
  });

  it('a forged manifest is a TAMPER in the embedded report, not a clean bill', async () => {
    // The security-relevant half. `orch audit` exits non-zero off bundle.report.intact,
    // and two examples gate on it, so a blind embedded report turns a caught forgery
    // into a silent pass.
    const { bundle, anchor, store } = await buildBundle({ forgeManifest: true });
    const recomputed = await verifyBundle(bundle, { anchor });

    // Sanity: verifyBundle does catch it, so this is purely about the embedded report.
    expect(recomputed.intact).toBe(false);
    expect(recomputed.failure).toBe('manifest');

    expect(bundle.report.intact).toBe(false);
    expect(bundle.report.failure).toBe('manifest');
    store.close();
  });
});
