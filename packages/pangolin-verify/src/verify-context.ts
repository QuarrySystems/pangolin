// Verify-context loading + the two assurance modes (offline / anchor-checked).
//
// The whole offline-vs-anchor-checked distinction is parametrized by which AuditAnchor
// `buildAnchor` returns — there is NO forked verify path (pangolin-core's verifyBundle
// runs the same algorithm either way). See VERIFICATION.md §2 and §4.

import { readFile } from 'node:fs/promises';
import { verify as edVerify, createPublicKey, type KeyObject } from 'node:crypto';
import type {
  AuditBundle,
  AuditAnchor,
  AnchoredRoot,
  AnchorReceipt,
  Signature,
  TimestampToken,
  S3LockClient,
} from '@quarry-systems/pangolin-core';
import { verifyTimestamp, verifyTimestampWithTime } from './timestamp-authority.js';
import { resolveKey, parseTrustRoot, type TrustRoot } from './trust-root.js';
import { keyUsableAt } from './revocation.js';

// ── Wire shapes (base64 for all binary fields; see VERIFICATION.md §2) ───────

export interface OfflineAnchorSpec {
  mode: 'offline';
}

export interface AnchorCheckedSpec {
  mode: 'anchor-checked';
  s3: {
    bucket: string;
    /** Object key of the WORM root record. Default: `audit/roots/<epochId>.json`. */
    key?: string;
  };
}

export type AnchorSpec = OfflineAnchorSpec | AnchorCheckedSpec;

/** The on-disk verify-context JSON (base64 for keys/certs). */
export interface VerifyContextJson {
  /** ed25519 SPKI-DER public key (base64). Omit to skip the signature check. */
  signerPublicKeySpkiDer?: string;
  anchor: AnchorSpec;
  /** Trusted TSA CA certs, each base64 DER. Omit/empty to skip the time check. */
  tsaCaCertsDer?: string[];
  /** Out-of-band published trust root mapping keyRef → public key + lifecycle.
   *  When present, signer verification uses makeVerifySignatureFromTrustRoot instead
   *  of the single-key path. NEVER read from the bundle. */
  trustRoot?: unknown;
}

/** The loaded, decoded verify-context. */
export interface VerifyContext {
  signerPublicKey?: KeyObject;
  anchor: AnchorSpec;
  tsaCaCertsDer: Uint8Array[];
  /** Injected by the caller for anchor-checked mode (the auditor owns the S3 client;
   *  this leaf package carries no AWS SDK). Absent => anchor-checked falls back to a
   *  clear error at fetch time. */
  s3?: S3LockClient;
  /** Validated trust root, decoded from the on-disk verify-context JSON.
   *  When present, signer verification resolves the public key by sig.keyRef.
   *  Never sourced from the bundle. */
  trustRoot?: TrustRoot;
}

function b64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

// ── Loaders ──────────────────────────────────────────────────────────────────

/** Load + JSON-parse an AuditBundle, converting base64 binary fields to Uint8Array. */
export async function loadBundle(path: string): Promise<AuditBundle> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as AuditBundle;
}

/** Load + decode a verify-context JSON file. */
export async function loadVerifyContext(
  path: string,
  opts: { s3?: S3LockClient } = {},
): Promise<VerifyContext> {
  const raw = await readFile(path, 'utf8');
  const json = JSON.parse(raw) as VerifyContextJson;
  const signerPublicKey = json.signerPublicKeySpkiDer
    ? createPublicKey({
        key: Buffer.from(b64(json.signerPublicKeySpkiDer)),
        format: 'der',
        type: 'spki',
      })
    : undefined;
  // If a trust root is present in the context, validate it fail-closed (disk-sourced
  // manifest — any malformation is a fatal misconfiguration, not a soft skip).
  const trustRoot: TrustRoot | undefined = json.trustRoot
    ? parseTrustRoot(JSON.stringify(json.trustRoot))
    : undefined;
  return {
    signerPublicKey,
    anchor: json.anchor,
    tsaCaCertsDer: (json.tsaCaCertsDer ?? []).map(b64),
    s3: opts.s3,
    trustRoot,
  };
}

// ── The base64-or-array root decoder ──────────────────────────────────────────
// A bundle round-tripped through JSON loses Uint8Array typing: a base64 string, a
// plain number[], or the {data:number[]} shim all need normalizing back to bytes.
function decodeBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return b64(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  if (v && typeof v === 'object' && Array.isArray((v as { data?: unknown }).data)) {
    return Uint8Array.from((v as { data: number[] }).data);
  }
  throw new Error('verify-context: cannot decode root/byte field');
}

/** Re-hydrate a JSON-decoded AnchoredRoot's binary fields (root, signature.bytes, token). */
function hydrateAnchoredRoot(ar: AnchoredRoot): AnchoredRoot {
  const signature: Signature | undefined = ar.signature
    ? { alg: ar.signature.alg, bytes: decodeBytes(ar.signature.bytes), keyRef: ar.signature.keyRef }
    : undefined;
  const timestamp: TimestampToken | undefined = ar.timestamp
    ? { ...ar.timestamp, token: decodeBytes(ar.timestamp.token) }
    : undefined;
  return { ...ar, root: decodeBytes(ar.root), signature, timestamp };
}

// ── Anchor builders (the mode switch lives HERE, not in verify) ───────────────

/**
 * Build the read-only AuditAnchor the verifier compares against.
 * - offline      → re-serve `bundle.auditLog.root` (guarantee 'detect' → tamper-detecting).
 * - anchor-checked → fetch the real WORM root from S3 Object-Lock ('external-immutable'
 *   → tamper-evident). Requires an injected S3 client on the context.
 */
export function buildAnchor(ctx: VerifyContext, bundle: AuditBundle): AuditAnchor {
  if (ctx.anchor.mode === 'anchor-checked') {
    const spec = ctx.anchor;
    const s3 = ctx.s3;
    const key = spec.s3.key ?? `audit/roots/${bundle.runId}.json`;
    const id = `s3:${spec.s3.bucket}`;
    return {
      id,
      guarantee: 'external-immutable',
      async anchor(): Promise<AnchorReceipt> {
        throw new Error('verify anchor is read-only');
      },
      async fetch(range): Promise<AnchoredRoot[]> {
        if (!s3) {
          throw new Error(
            'verify: anchor-checked mode requires an injected S3LockClient (loadVerifyContext({ s3 }))',
          );
        }
        const raw = await s3.getObject(key);
        if (!raw) return [];
        const o = JSON.parse(new TextDecoder().decode(raw)) as {
          epochId: string;
          rootHex: string;
          signature?: { alg: string; bytesHex: string; keyRef?: string };
          receipt: AnchorReceipt;
        };
        const signature: Signature | undefined = o.signature
          ? {
              alg: o.signature.alg,
              bytes: Uint8Array.from(Buffer.from(o.signature.bytesHex, 'hex')),
              keyRef: o.signature.keyRef,
            }
          : undefined;
        const epochId = range?.epochId ?? o.epochId;
        return [
          {
            epochId,
            root: Uint8Array.from(Buffer.from(o.rootHex, 'hex')),
            signature,
            receipt: o.receipt,
          },
        ];
      },
    };
  }

  // offline: re-serve the bundle's own claimed root (claim ceiling: tamper-detecting).
  const embedded = bundle.auditLog.root ? hydrateAnchoredRoot(bundle.auditLog.root) : undefined;
  const id = 'offline';
  return {
    id,
    guarantee: 'detect',
    async anchor(): Promise<AnchorReceipt> {
      throw new Error('verify anchor is read-only');
    },
    async fetch(): Promise<AnchoredRoot[]> {
      return embedded ? [embedded] : [];
    },
  };
}

// ── Verified genTime extraction (for key-lifecycle gate at the CLI call site) ──

/** Extract a TSA-verified genTime from the bundle's embedded anchored root, if present and
 *  trusted by `ctx.tsaCaCertsDer`. Returns undefined when certs are absent, the root has no
 *  timestamp token, or verification fails. Never returns a self-asserted / operator-supplied
 *  time — ONLY a time proven by a verified RFC-3161 token.
 *
 *  Call this BEFORE building the signature callback so the lifecycle gate in
 *  makeVerifySignatureFromTrustRoot can receive a trusted genTime. */
export function extractVerifiedGenTime(ctx: VerifyContext, bundle: AuditBundle): Date | undefined {
  if (ctx.tsaCaCertsDer.length === 0) return undefined;
  const embeddedRoot = bundle.auditLog.root;
  if (!embeddedRoot) return undefined;
  const hydratedRoot = hydrateAnchoredRoot(embeddedRoot);
  if (!hydratedRoot.timestamp) return undefined;
  const result = verifyTimestampWithTime(
    hydratedRoot.root,
    hydratedRoot.timestamp,
    ctx.tsaCaCertsDer,
  );
  return result.ok ? result.genTime : undefined;
}

// ── Injected verifier callbacks (what core's verifyBundle consumes) ───────────

/** The single algorithm→node-crypto-verify mapping. ed25519 = PureEdDSA (digest null);
 *  ecdsa-p256 = ECDSA over SHA-256, DER (node's default). Unknown alg → false. Never throws.
 *  Sole place the per-alg verify is written; all verify callbacks in this module route through it. */
function verifySignatureBytes(
  alg: string,
  root: Uint8Array,
  key: KeyObject,
  sigBytes: Uint8Array,
): boolean {
  try {
    if (alg === 'ed25519') return edVerify(null, Buffer.from(root), key, Buffer.from(sigBytes));
    if (alg === 'ecdsa-p256')
      return edVerify('sha256', Buffer.from(root), key, Buffer.from(sigBytes));
    return false;
  } catch {
    return false;
  }
}

/** Verify over the root bytes, using the context's SPKI-DER public key.
 *  Dispatches on sig.alg (ed25519 | ecdsa-p256) via verifySignatureBytes.
 *  Returns undefined when no key is configured (→ core treats the check as 'n/a'). */
export function makeVerifySignature(
  ctx: VerifyContext,
): ((root: Uint8Array, sig: Signature) => boolean) | undefined {
  const key = ctx.signerPublicKey;
  if (!key) return undefined;
  return (root, sig) => verifySignatureBytes(sig.alg, root, key, sig.bytes);
}

/** RFC 3161 time verify bound to the context's TSA CA certs. Returns undefined when no
 *  certs are configured (→ core treats the time check as 'n/a'/asserted). */
export function makeVerifyTimestamp(
  ctx: VerifyContext,
): ((root: Uint8Array, token: TimestampToken) => boolean) | undefined {
  if (ctx.tsaCaCertsDer.length === 0) return undefined;
  const certs = ctx.tsaCaCertsDer;
  return (root, token) => verifyTimestamp(root, token, certs);
}

/** Verify callback resolving the pubkey by sig.keyRef from a published trust root.
 *  No trust root → undefined (core 'n/a'). keyRef unknown → false (hard fail). alg must
 *  match the published entry. Crypto goes through the shared verifySignatureBytes primitive.
 *  `verifiedGenTime` (the RFC-3161-verified signing time, when available) drives the
 *  key-lifecycle gate (validity window + time-bounded revocation). */
export function makeVerifySignatureFromTrustRoot(
  trustRoot: TrustRoot | undefined,
  verifiedGenTime?: Date,
): ((root: Uint8Array, sig: Signature) => boolean) | undefined {
  if (!trustRoot) return undefined;
  return (root, sig) => {
    const entry = resolveKey(trustRoot, sig.keyRef);
    if (!entry) return false; // unrecognized signer = hard fail
    if (entry.alg !== sig.alg) return false; // alg must match the published entry
    if (!keyUsableAt(entry, verifiedGenTime)) return false; // lifecycle gate: window + revocation
    let key: KeyObject;
    try {
      key = createPublicKey({
        key: Buffer.from(entry.spkiDer, 'base64'),
        format: 'der',
        type: 'spki',
      });
    } catch {
      return false; // malformed base64 / SPKI
    }
    return verifySignatureBytes(sig.alg, root, key, sig.bytes);
  };
}
