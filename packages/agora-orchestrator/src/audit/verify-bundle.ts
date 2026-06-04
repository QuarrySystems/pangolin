import type { AuditBundle, AuditStore, AuditAnchor, Signature, VerificationReport } from '../contracts/index.js';
import { verify } from './verify.js';

export function verifyBundle(
  bundle: AuditBundle,
  deps: { anchor: AuditAnchor; verifySignature?: (root: Uint8Array, sig: Signature) => boolean },
): Promise<VerificationReport> {
  const entries = bundle.auditLog.entries;
  const store = { getAuditEntries: () => entries } as Pick<AuditStore, 'getAuditEntries'> as AuditStore;
  return verify(bundle.runId, { store, anchor: deps.anchor, verifySignature: deps.verifySignature });
}
