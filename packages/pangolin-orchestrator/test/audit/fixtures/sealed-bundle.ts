// Shared builders for sealed AuditBundle fixtures.
//
// Extracted from verify-bundle.test.ts so the signature-tristate tests reuse the SAME
// construction rather than a hand-rolled near-copy. Getting the chain wrong here is
// quiet and misleading — a bundle whose entries do not link fails the CHAIN check, so
// every downstream assertion reports a failure that has nothing to do with what the
// test meant to exercise. One builder, one place to be right.
import type {
  AuditBundle,
  AuditAnchor,
  AuditEntryRow,
  AnchoredRoot,
  DispatchManifest,
  Signature,
} from '../../../src/contracts/index.js';
import { canonEntry } from '../../../src/audit/canon.js';
import { chainHash, merkleRoot, leavesFromEntryHashes } from '../../../src/audit/merkle.js';

export type GuaranteeType = 'detect' | 'external-immutable' | 'witnessed';

/** A dummy signature; the injected verifySignature decides pass/fail, so the bytes are irrelevant. */
export const SIG: Signature = { alg: 'ed25519', bytes: new Uint8Array([9]) };

/** A fake AuditAnchor serving exactly one AnchoredRoot. Pass `signature` to model a signed
 *  seal (the anchored root carries it) — required for the tamper-evident claim, which
 *  demands a verified signature. */
export const anchorOf = (
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
export type Producer = {
  id: string;
  status?: 'done' | 'failed';
  resultRef?: string;
  outputRefs?: Record<string, string>;
};

/** Build chained AuditEntryRows (run.submitted, one item.reconciled per producer, run.completed)
 *  and compute their merkle root. */
export function buildEntries(
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

/** Build a sealed AuditBundle with correct chain + merkle root.
 *  Note: the pre-populated `report` satisfies AuditBundle's type only; verifyBundle recomputes it. */
export function buildSealedBundle(
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

/** Build a minimal DispatchManifest with optional inputRefs. */
export function manifestFor(
  itemId: string,
  inputRefs: Record<string, string> = {},
): DispatchManifest {
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
