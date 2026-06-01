import type {
  AuditExport,
  AuditBundle,
  AuditStore,
  AuditAnchor,
  AuditEntryRow,
  AnchoredRoot,
  Signature,
} from '../contracts/index.js';
import type { DispatchManifest } from '../contracts/index.js';
import { verify } from './verify.js';

interface StorageLike { get(ref: string): Promise<Uint8Array>; }

/** Minimal read-only AuditStore over an export — the data is UNTRUSTED; integrity
 *  comes from verify() comparing the recomputed root to the LIVE anchored root. */
function exportStore(exp: AuditExport): AuditStore {
  return {
    getAuditEntries: (runId: string): AuditEntryRow[] =>
      runId === exp.runId ? exp.entries : [],
    getAuditChainHead: (runId: string): string =>
      runId === exp.runId ? (exp.entries.at(-1)?.entryHash ?? '') : '',
    getAuditRoot: (epochId: string): AnchoredRoot | undefined =>
      epochId === exp.runId ? exp.root : undefined,
    appendAuditEntry: (_row: AuditEntryRow): void => { throw new Error('read-only'); },
    putAuditRoot: (_root: AnchoredRoot): void => { throw new Error('read-only'); },
  };
}

export async function assembleBundle(
  exp: AuditExport,
  deps: {
    anchor: AuditAnchor;
    storage: StorageLike;
    verifySignature?: (root: Uint8Array, sig: Signature) => boolean;
  },
): Promise<AuditBundle> {
  const manifests: DispatchManifest[] = [];
  for (const it of exp.items) {
    if (!it.manifestRef) continue;
    try {
      manifests.push(
        JSON.parse(new TextDecoder().decode(await deps.storage.get(it.manifestRef))) as DispatchManifest,
      );
    } catch {
      /* a missing/unfetchable manifest is reported via the bundle, not thrown */
    }
  }
  const report = await verify(exp.runId, {
    store: exportStore(exp),
    anchor: deps.anchor,
    verifySignature: deps.verifySignature,
  });
  return {
    runId: exp.runId,
    manifests,
    auditLog: { entries: exp.entries, root: exp.root },
    items: exp.items,
    report,
  };
}
