import type { TrustRootKey } from './trust-root.js';

/** Parse a strict-ISO timestamp to epoch ms; parseTrustRoot already validated format,
 *  but guard NaN defensively so a bad value fails closed, never opens. */
function ms(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`keyUsableAt: unparseable timestamp ${iso}`);
  return t;
}

/** Is this trust-root key usable for a signature whose VERIFIED signing time is
 *  `verifiedGenTime` (from a tsa-attested token; undefined when only asserted time exists)?
 *  - revoked: usable iff verified genTime proves signing strictly before revokedAt (else hard-fail).
 *  - active : usable; if a verified genTime exists it must fall within [notBefore, notAfter].
 *    Without a verified genTime the window is advisory (revocation remains the hard control). */
export function keyUsableAt(entry: TrustRootKey, verifiedGenTime: Date | undefined): boolean {
  if (entry.status === 'revoked') {
    if (!entry.revokedAt || !verifiedGenTime) return false;
    return verifiedGenTime.getTime() < ms(entry.revokedAt);
  }
  if (!verifiedGenTime) return true;
  const t = verifiedGenTime.getTime();
  if (t < ms(entry.notBefore)) return false;
  if (entry.notAfter != null && t > ms(entry.notAfter)) return false;
  return true;
}
