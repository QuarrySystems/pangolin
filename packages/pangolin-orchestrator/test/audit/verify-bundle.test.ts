import { it, expect } from 'vitest';
import type {
  AuditBundle,
  AuditAnchor,
  AuditEntryRow,
  AnchoredRoot,
  DispatchManifest,
  Signature,
} from '../../src/contracts/index.js';
import { canonEntry } from '../../src/audit/canon.js';
import { chainHash, merkleRoot, leavesFromEntryHashes } from '../../src/audit/merkle.js';
import { verifyBundle } from '../../src/audit/verify-bundle.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type GuaranteeType = 'detect' | 'external-immutable' | 'witnessed';

/** A dummy signature; the injected verifySignature decides pass/fail, so the bytes are irrelevant. */
const SIG: Signature = { alg: 'ed25519', bytes: new Uint8Array([9]) };

/** Build a fake AuditAnchor that serves exactly one AnchoredRoot. Pass `signature` to model a
 *  signed seal (the anchored root carries it) — required for the tamper-evident claim, which now
 *  demands a verified signature. */
const anchorOf = (
  root: Uint8Array,
  guarantee: GuaranteeType = 'external-immutable',
  signature?: Signature,
) =>
  ({
    id: 'fake',
    guarantee,
    async anchor() {
      return { anchorId: 'fake', epochId: 'r', guarantee, at: 0 };
    },
    async fetch() {
      return [
        {
          epochId: 'r',
          root,
          ...(signature ? { signature } : {}),
          receipt: { anchorId: 'fake', epochId: 'r', guarantee, at: 0 },
        },
      ];
    },
  }) satisfies AuditAnchor;

/** A producer to seal into the chain as a sealed `item.reconciled` entry. Provenance closure
 *  derives the producer set from THESE chained entries, never the untrusted bundle.items rows. */
type Producer = {
  id: string;
  status?: 'done' | 'failed';
  resultRef?: string;
  outputRefs?: Record<string, string>;
};

/** Build chained AuditEntryRows (run.submitted, one item.reconciled per producer, run.completed)
 *  and compute their merkle root. */
function buildEntries(
  runId: string,
  producers: Producer[] = [],
): { entries: AuditEntryRow[]; root: Uint8Array } {
  const rows: AuditEntryRow[] = [];
  let prev = '';
  const push = (e: Omit<AuditEntryRow, 'entryHash' | 'prevHash' | 'runId'>) => {
    const entry = { ...e, runId };
    const eh = chainHash(canonEntry(entry), prev);
    rows.push({ ...entry, entryHash: eh, prevHash: prev });
    prev = eh;
  };

  let seq = 0;
  push({ seq: seq++, kind: 'run.submitted', at: 't0' });
  for (const p of producers) {
    push({
      seq: seq++,
      kind: 'item.reconciled',
      itemId: p.id,
      status: p.status ?? 'done',
      ...(p.resultRef ? { resultRef: p.resultRef } : {}),
      ...(p.outputRefs ? { outputRefs: p.outputRefs } : {}),
      at: 't0',
    });
  }
  push({ seq: seq++, kind: 'run.completed', at: 't1' });
  const root = merkleRoot(leavesFromEntryHashes(rows.map((r) => r.entryHash)));
  return { entries: rows, root };
}

/** Build a sealed AuditBundle with correct chain + merkle root. */
function buildSealedBundle(
  runId: string = 'r',
  producers: Producer[] = [],
): { bundle: AuditBundle; root: Uint8Array } {
  const { entries, root } = buildEntries(runId, producers);
  const anchoredRoot: AnchoredRoot = {
    epochId: runId,
    root,
    receipt: { anchorId: 'fake', epochId: runId, guarantee: 'external-immutable', at: 0 },
  };
  const bundle: AuditBundle = {
    runId,
    manifests: [],
    auditLog: { entries, root: anchoredRoot },
    items: [],
    report: {
      runId,
      anchorId: 'fake',
      guarantee: 'external-immutable',
      intact: true,
      claim: 'tamper-evident',
      checks: {
        chain: { ok: true },
        root: { ok: true },
        signature: { ok: 'n/a' },
        anchor: { ok: true },
        handoff: { ok: 'n/a' },
      },
    },
  };
  return { bundle, root };
}

// Note: pre-populated report satisfies AuditBundle's type only; verifyBundle recomputes it.

/** Build a minimal DispatchManifest with optional inputRefs. */
function manifestFor(itemId: string, inputRefs: Record<string, string> = {}): DispatchManifest {
  return {
    schemaVersion: 1,
    runId: 'r',
    itemId,
    parent: 'run:r',
    executor: 'dispatch',
    executorManifest: {},
    secretRefs: [],
    actor: 'human:test',
    firedAt: 't0',
    manifestHash: 'sha256:dummy',
    inputRefs: Object.keys(inputRefs).length > 0 ? inputRefs : undefined,
  };
}

// Stable fake refs for tests
const REF_A = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REF_O = 'sha256:oooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo';
const REF_GHOST = 'sha256:deaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead';
const REF_FORGE = 'sha256:f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it('verifies a self-contained sealed bundle against the supplied external anchor', async () => {
  const { bundle, root } = buildSealedBundle();
  // Signed seal + a passing verifier: tamper-evident is EARNED (it now requires a verified signature).
  const r = await verifyBundle(bundle, {
    anchor: anchorOf(root, 'external-immutable', SIG),
    verifySignature: () => true,
  });
  expect(r.intact).toBe(true);
  expect(r.claim).toBe('tamper-evident');
});

it('a bundle whose entries were altered fails against the unchanged anchored root', async () => {
  const { bundle, root } = buildSealedBundle();
  // Mutate actor on the first entry AFTER computing entryHash, breaking the chain
  bundle.auditLog.entries[0]!.actor = 'attacker';
  const r = await verifyBundle(bundle, { anchor: anchorOf(root) });
  expect(r.intact).toBe(false);
  expect(r.checks.chain.ok).toBe(false);
});

it('detect-tier anchor on an intact bundle returns tamper-detecting', async () => {
  const { bundle, root } = buildSealedBundle();
  const r = await verifyBundle(bundle, { anchor: anchorOf(root, 'detect') });
  expect(r.intact).toBe(true);
  expect(r.claim).toBe('tamper-detecting');
});

it('ignores bundle.auditLog.root — an intact bundle with a garbage embedded root still verifies via the anchor', async () => {
  // The chain is left INTACT; only the embedded root is corrupted. If verifyBundle trusted the
  // embedded root it would report a root mismatch. It must pass, because the anchor holds the truth —
  // which directly proves the embedded root is never consulted.
  const { bundle, root } = buildSealedBundle();
  bundle.auditLog.root = {
    epochId: 'r',
    root: new Uint8Array(32).fill(0xff), // garbage embedded root
    receipt: { anchorId: 'fake', epochId: 'r', guarantee: 'external-immutable', at: 0 },
  };

  const r = await verifyBundle(bundle, { anchor: anchorOf(root, 'external-immutable') });

  expect(r.intact).toBe(true); // embedded garbage ignored; the anchored root is authoritative
  expect(r.checks.root.ok).toBe(true);
});

it('a root-mismatch is detected when recomputed root differs from the anchored one', async () => {
  const { bundle } = buildSealedBundle();
  // Supply a different (wrong) root via the anchor
  const wrongRoot = new Uint8Array(32).fill(0xab);
  const r = await verifyBundle(bundle, { anchor: anchorOf(wrongRoot, 'external-immutable') });
  expect(r.intact).toBe(false);
  expect(r.failure).toBe('root-mismatch');
  expect(r.checks.root.ok).toBe(false);
});

it('passes verifySignature through to verify() correctly', async () => {
  const { bundle, root } = buildSealedBundle();
  const r = await verifyBundle(bundle, {
    anchor: anchorOf(root, 'external-immutable'),
    verifySignature: () => true,
  });
  expect(r.intact).toBe(true);
});

it('a bad verifySignature causes intact to be false', async () => {
  const { bundle, root } = buildSealedBundle();
  // Signed anchor + a failing verifier: the signature check fires and fails.
  const r = await verifyBundle(bundle, {
    anchor: anchorOf(root, 'external-immutable', SIG),
    verifySignature: () => false,
  });
  expect(r.intact).toBe(false);
  expect(r.failure).toBe('signature');
});

// ---------------------------------------------------------------------------
// Handoff closure tests (spec §7)
// ---------------------------------------------------------------------------

it('bundle with no manifests (zero inputRefs) reports handoff ok: true, no handoff edges', async () => {
  const { bundle, root } = buildSealedBundle();
  // manifests: [] (default) — zero handoff edges. Signed seal + verifier so the claim is earned.
  const r = await verifyBundle(bundle, {
    anchor: anchorOf(root, 'external-immutable', SIG),
    verifySignature: () => true,
  });
  expect(r.checks.handoff).toEqual({ ok: true, detail: 'no handoff edges' });
  expect(r.intact).toBe(true);
  expect(r.claim).toBe('tamper-evident');
});

it('handoff passes when every consumed inputRef matches a CHAIN-SEALED producer resultRef', async () => {
  const { bundle, root } = buildSealedBundle('r', [{ id: 'a', resultRef: REF_A }]);
  bundle.manifests = [manifestFor('b', { patch: REF_A })];
  const r = await verifyBundle(bundle, { anchor: anchorOf(root) });
  expect(r.checks.handoff).toEqual({ ok: true, detail: '1 input ref accounted for' });
  expect(r.intact).toBe(true);
});

it('handoff fails closed on an unaccounted input ref', async () => {
  const { bundle, root } = buildSealedBundle('r');
  bundle.items = [{ id: 'a', status: 'done' }];
  bundle.manifests = [manifestFor('b', { patch: REF_GHOST })];
  const r = await verifyBundle(bundle, { anchor: anchorOf(root) });
  expect(r.checks.handoff).toEqual({
    ok: false,
    detail: `item b input patch: ${REF_GHOST} not produced by any item in this run`,
  });
  expect(r.intact).toBe(false);
  expect(r.failure).toBe('handoff');
});

it('outputRefs products sealed in the chain also satisfy the handoff closure', async () => {
  const { bundle, root } = buildSealedBundle('r', [{ id: 'a', outputRefs: { 'data.bin': REF_O } }]);
  bundle.manifests = [manifestFor('b', { data: REF_O })];
  const r = await verifyBundle(bundle, { anchor: anchorOf(root) });
  expect(r.checks.handoff).toEqual({ ok: true, detail: '1 input ref accounted for' });
  expect(r.intact).toBe(true);
});

it('multiple inputRefs accounted for yields plural detail message', async () => {
  const { bundle, root } = buildSealedBundle('r', [
    { id: 'a', resultRef: REF_A },
    { id: 'b', outputRefs: { 'data.bin': REF_O } },
  ]);
  bundle.manifests = [manifestFor('c', { patch: REF_A, data: REF_O })];
  const r = await verifyBundle(bundle, { anchor: anchorOf(root) });
  expect(r.checks.handoff).toEqual({ ok: true, detail: '2 input refs accounted for' });
  expect(r.intact).toBe(true);
});

it('a tampered chain AND broken closure reports failure === chain (earlier check wins)', async () => {
  const { bundle, root } = buildSealedBundle('r');
  // Tamper the chain
  bundle.auditLog.entries[0]!.actor = 'attacker';
  // Add a broken closure on top
  bundle.items = [{ id: 'a', status: 'done' }];
  bundle.manifests = [manifestFor('b', { patch: REF_GHOST })];
  const r = await verifyBundle(bundle, { anchor: anchorOf(root) });
  expect(r.failure).toBe('chain');
  expect(r.intact).toBe(false);
});

it('handoff failure cannot yield tamper-evident claim', async () => {
  const { bundle, root } = buildSealedBundle('r');
  bundle.items = [{ id: 'a', status: 'done' }];
  bundle.manifests = [manifestFor('b', { patch: REF_GHOST })];
  const r = await verifyBundle(bundle, { anchor: anchorOf(root) });
  // claim must be tamper-detecting (never tamper-evident) because intact is false
  expect(r.claim).toBe('tamper-detecting');
});

it('a CHAIN-SEALED producer with status failed does NOT satisfy the handoff closure', async () => {
  // A failed item is not a legitimate producer even when its resultRef is sealed in the chain.
  const { bundle, root } = buildSealedBundle('r', [
    { id: 'a', status: 'failed', resultRef: REF_A },
  ]);
  bundle.manifests = [manifestFor('b', { patch: REF_A })];
  const r = await verifyBundle(bundle, { anchor: anchorOf(root) });
  expect(r.checks.handoff.ok).toBe(false);
  expect(r.intact).toBe(false);
  expect(r.failure).toBe('handoff');
});

it('empty-string outputRef is not a valid producer (falsy ref guard)', async () => {
  // An empty-string ref is not a valid content hash and must not satisfy a manifest inputRef.
  const EMPTY = '';
  const { bundle, root } = buildSealedBundle('r', [{ id: 'a', outputRefs: { 'data.bin': EMPTY } }]);
  bundle.manifests = [manifestFor('b', { data: EMPTY })];
  const r = await verifyBundle(bundle, { anchor: anchorOf(root) });
  // An empty inputRef is itself invalid — bundle must fail closure.
  expect(r.checks.handoff.ok).toBe(false);
  expect(r.intact).toBe(false);
  expect(r.failure).toBe('handoff');
});

// ---------------------------------------------------------------------------
// Provenance closure binds to the CHAIN, not the untrusted bundle.items export
// (hardening 2026-06-19): a forged export row must NOT satisfy a consumed input
// ref — the producer set is derived from sealed `item.reconciled` chain entries.
// ---------------------------------------------------------------------------

it('a forged bundle.items row does NOT satisfy closure (resultRef provenance forgery)', async () => {
  // The chain seals NO producer for REF_FORGE. An attacker with the export appends a row claiming
  // a ghost item produced it. Closure must reject — producers come from the chain, not bundle.items.
  const { bundle, root } = buildSealedBundle('r'); // no chain producers
  bundle.items = [{ id: 'ghost', status: 'done', resultRef: REF_FORGE }];
  bundle.manifests = [manifestFor('b', { patch: REF_FORGE })];
  const r = await verifyBundle(bundle, { anchor: anchorOf(root) });
  expect(r.checks.handoff.ok).toBe(false);
  expect(r.intact).toBe(false);
  expect(r.failure).toBe('handoff');
});

it('a forged bundle.items outputRefs row does NOT satisfy closure (outputRefs provenance forgery)', async () => {
  // The outputRefs lane must be closed too: the chain seals no producer; the attacker forges an
  // export row carrying outputRefs. Closure must reject it just like the resultRef lane.
  const { bundle, root } = buildSealedBundle('r');
  bundle.items = [{ id: 'ghost', status: 'done', outputRefs: { 'data.bin': REF_FORGE } }];
  bundle.manifests = [manifestFor('b', { data: REF_FORGE })];
  const r = await verifyBundle(bundle, { anchor: anchorOf(root) });
  expect(r.checks.handoff.ok).toBe(false);
  expect(r.intact).toBe(false);
  expect(r.failure).toBe('handoff');
});

it('a chain-sealed producer outputRef is tamper-protected (mutating it breaks the chain)', async () => {
  const { bundle, root } = buildSealedBundle('r', [{ id: 'a', outputRefs: { 'data.bin': REF_O } }]);
  bundle.manifests = [manifestFor('b', { data: REF_O })];
  // Mutate the sealed outputRefs on the chained reconcile entry AFTER its hash was computed. If
  // canonEntry did not cover outputRefs, this swap would go undetected and forge provenance.
  const reconciled = bundle.auditLog.entries.find((e) => e.kind === 'item.reconciled')!;
  reconciled.outputRefs = { 'data.bin': REF_FORGE };
  const r = await verifyBundle(bundle, { anchor: anchorOf(root) });
  expect(r.checks.chain.ok).toBe(false);
  expect(r.intact).toBe(false);
});
