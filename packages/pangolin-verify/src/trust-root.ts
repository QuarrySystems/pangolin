// Published, out-of-band trust root mapping keyRef -> public key + lifecycle. NEVER
// read from the bundle (a bundle-supplied key is self-attesting/forgeable — rejected
// in PR #70). The auditor supplies this via the verify-context.
export interface TrustRootKey {
  alg: 'ed25519' | 'ecdsa-p256';
  /** base64 SPKI-DER. */
  spkiDer: string;
  status: 'active' | 'revoked';
  notBefore: string; // strict ISO-8601 with offset/Z
  notAfter?: string | null; // strict ISO-8601 | null
  revokedAt?: string | null; // strict ISO-8601 | null (REQUIRED iff status==='revoked')
}

export interface TrustRoot {
  schemaVersion: 1;
  keys: Record<string, TrustRootKey>;
}

const ALGS = new Set(['ed25519', 'ecdsa-p256']);
// Strict ISO-8601 with an explicit Z or +/-hh:mm offset, so Date.parse is unambiguous (not local-TZ).
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function assertIso(v: unknown, field: string): string {
  if (typeof v !== 'string' || !ISO.test(v) || Number.isNaN(Date.parse(v))) {
    throw new Error(`trust-root: ${field} must be strict ISO-8601 with offset, got ${String(v)}`);
  }
  return v;
}

/** Pure lookup of a key entry by keyRef. The lifecycle DECISION lives in the revocation
 *  layer (keyUsableAt); this only resolves the entry. */
export function resolveKey(tr: TrustRoot, keyRef: string | undefined): TrustRootKey | undefined {
  if (!keyRef) return undefined;
  return tr.keys[keyRef];
}

/** Parse + validate an UNTRUSTED trust-root JSON string. Throws on anything malformed —
 *  the manifest is the security root, so fail closed rather than silently degrade. */
export function parseTrustRoot(json: string): TrustRoot {
  const raw = JSON.parse(json) as unknown; // throws on bad JSON
  if (!raw || typeof raw !== 'object') throw new Error('trust-root: not an object');
  const o = raw as { schemaVersion?: unknown; keys?: unknown };
  if (o.schemaVersion !== 1)
    throw new Error(`trust-root: unsupported schemaVersion ${String(o.schemaVersion)}`);
  if (!o.keys || typeof o.keys !== 'object') throw new Error('trust-root: keys must be an object');
  const keys: Record<string, TrustRootKey> = {};
  for (const [ref, v] of Object.entries(o.keys as Record<string, unknown>)) {
    const e = v as Record<string, unknown>;
    if (!ALGS.has(e.alg as string))
      throw new Error(`trust-root: key ${ref} has invalid alg ${String(e.alg)}`);
    if (typeof e.spkiDer !== 'string' || e.spkiDer.length === 0)
      throw new Error(`trust-root: key ${ref} missing spkiDer`);
    if (e.status !== 'active' && e.status !== 'revoked')
      throw new Error(`trust-root: key ${ref} invalid status`);
    assertIso(e.notBefore, `key ${ref} notBefore`);
    if (e.notAfter != null) assertIso(e.notAfter, `key ${ref} notAfter`);
    if (e.status === 'revoked')
      assertIso(e.revokedAt, `key ${ref} revokedAt (required for revoked)`);
    else if (e.revokedAt != null) assertIso(e.revokedAt, `key ${ref} revokedAt`);
    keys[ref] = {
      alg: e.alg as TrustRootKey['alg'],
      spkiDer: e.spkiDer,
      status: e.status,
      notBefore: e.notBefore as string,
      notAfter: (e.notAfter as string | null) ?? null,
      revokedAt: (e.revokedAt as string | null) ?? null,
    };
  }
  return { schemaVersion: 1, keys };
}
