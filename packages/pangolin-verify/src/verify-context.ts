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
import { verifyTimestamp } from './timestamp-authority.js';

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
    ? createPublicKey({ key: Buffer.from(b64(json.signerPublicKeySpkiDer)), format: 'der', type: 'spki' })
    : undefined;
  return {
    signerPublicKey,
    anchor: json.anchor,
    tsaCaCertsDer: (json.tsaCaCertsDer ?? []).map(b64),
    s3: opts.s3,
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
        return [{ epochId, root: Uint8Array.from(Buffer.from(o.rootHex, 'hex')), signature, receipt: o.receipt }];
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

// ── Injected verifier callbacks (what core's verifyBundle consumes) ───────────

/** ed25519 verify over the root bytes, using the context's SPKI-DER public key.
 *  Returns undefined when no key is configured (→ core treats the check as 'n/a'). */
export function makeVerifySignature(
  ctx: VerifyContext,
): ((root: Uint8Array, sig: Signature) => boolean) | undefined {
  const key = ctx.signerPublicKey;
  if (!key) return undefined;
  return (root, sig) => {
    try {
      return edVerify(null, Buffer.from(root), key, Buffer.from(sig.bytes));
    } catch {
      return false;
    }
  };
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
