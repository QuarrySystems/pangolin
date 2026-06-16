// RFC 3161 trusted-time: a synchronous verifier plus two TimestampAuthority
// implementations (a local self-CA for offline tests/demos, and a network client
// for a real TSA). This is the package that owns the ASN.1/CMS weight (pkijs/asn1js)
// so pangolin-core stays dependency-light.
//
// Ported from spike/rfc3161/roundtrip.mjs (the ratified prototype) — see
// spike/rfc3161/FINDINGS.md for the load-bearing gotchas referenced inline. The port
// does CMS signing/verification with node:crypto (sync RSA-SHA256 over the eContent —
// our tokens carry no signed attributes) rather than pkijs's async verify, so both the
// verifier and the local-CA mint are synchronous-friendly and `verifyTimestamp` can
// return a plain boolean (never throwing — FINDINGS gotcha #3).

import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import {
  webcrypto,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  createPublicKey,
  createHash,
  type KeyObject,
} from 'node:crypto';
import type { TimestampToken, TimestampAuthority } from '@quarry-systems/pangolin-core';

// ── Engine wiring (FINDINGS gotcha #7) ──────────────────────────────────────
// pkijs has no crypto of its own; it drives WebCrypto. Wire it once at module load.
// Used for the network TSA's request/response codec (the local CA signs via node:crypto).
// Node's webcrypto types diverge from the DOM `Crypto`/`SubtleCrypto` lib types pkijs
// expects (e.g. a newer KeyUsage union); the runtime objects are compatible. Cast once.
const wc = webcrypto as unknown as Crypto;
pkijs.setEngine('node', new pkijs.CryptoEngine({ name: 'node', crypto: wc, subtle: wc.subtle }));

const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_TSA_EKU = '1.3.6.1.5.5.7.3.8'; // id-kp-timeStamping
const OID_EKU_EXT = '2.5.29.37';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_RSA_SHA256 = '1.2.840.113549.1.1.11';
const OID_CONTENT_TYPE_ATTR = '1.2.840.113549.1.9.3'; // id-contentType
const OID_MESSAGE_DIGEST_ATTR = '1.2.840.113549.1.9.4'; // id-messageDigest
const OID_CT_TSTINFO = '1.2.840.113549.1.9.16.1.4'; // id-ct-TSTInfo

/** The messageImprint / message-digest hash: SHA-256 of the input bytes. The single
 *  definition mint, verify, and the network client all use — so they cannot drift (M2). */
function imprintHash(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

function toUint8(buf: ArrayBuffer): Uint8Array {
  return new Uint8Array(buf);
}

/** asn1js.fromBER wants a standalone ArrayBuffer; copy into a fresh one (also avoids a
 *  SharedArrayBuffer leaking through `.buffer`). */
function ber(bytes: Uint8Array): ReturnType<typeof asn1js.fromBER> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return asn1js.fromBER(copy.buffer);
}

function hexView(o: { valueBlock: unknown }): Uint8Array {
  return new Uint8Array((o.valueBlock as { valueHexView: Uint8Array }).valueHexView);
}

/** A pkijs Certificate's SubjectPublicKeyInfo as a node KeyObject (sync). */
function publicKeyOf(cert: pkijs.Certificate): KeyObject {
  const spkiDer = toUint8(cert.subjectPublicKeyInfo.toSchema().toBER(false));
  return createPublicKey({ key: Buffer.from(spkiDer), format: 'der', type: 'spki' });
}

/** Raw DER of a pkijs Certificate (for byte-identity comparison against trusted certs). */
function certDer(cert: pkijs.Certificate): Uint8Array {
  return toUint8(cert.toSchema(true).toBER(false));
}

// FINDINGS gotcha #1: after a CMS encode/decode roundtrip the encapsulated TSTInfo
// OCTET STRING comes back CONSTRUCTED — the parent .valueHexView is empty and the real
// bytes live (possibly chunked) in .valueBlock.value[]. Concatenate the children for
// the constructed case; use the flat view for the primitive case.
function extractEContentBytes(octetString: asn1js.OctetString): Uint8Array {
  const vb = octetString.valueBlock as unknown as {
    isConstructed?: boolean;
    value?: Array<{ valueBlock: { valueHexView: Uint8Array } }>;
    valueHexView: Uint8Array;
  };
  if (vb.isConstructed && Array.isArray(vb.value) && vb.value.length) {
    const parts = vb.value.map((child) => new Uint8Array(child.valueBlock.valueHexView));
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return out;
  }
  return new Uint8Array(vb.valueHexView);
}

function setRDN(typesAndValues: pkijs.AttributeTypeAndValue[], cn: string): void {
  typesAndValues.push(
    new pkijs.AttributeTypeAndValue({
      type: '2.5.4.3', // commonName
      value: new asn1js.Utf8String({ value: cn }),
    }),
  );
}

interface BuildCertArgs {
  subjectCN: string;
  issuerCN: string;
  subjectSpkiDer: Uint8Array;
  issuerPrivKey: KeyObject;
  serial: number;
  isCa?: boolean;
  isTsa?: boolean;
  /** Override the cert validity window (defaults to now-60s .. now+1y). For tests. */
  notBefore?: Date;
  notAfter?: Date;
}

/** Build + sign an X.509 cert synchronously (node:crypto RSA-SHA256 over the TBS). */
function buildCertSync(args: BuildCertArgs): pkijs.Certificate {
  const cert = new pkijs.Certificate();
  cert.version = 2; // v3
  cert.serialNumber = new asn1js.Integer({ value: args.serial });
  setRDN(cert.issuer.typesAndValues, args.issuerCN);
  setRDN(cert.subject.typesAndValues, args.subjectCN);

  const now = new Date();
  cert.notBefore.value = args.notBefore ?? new Date(now.getTime() - 60_000);
  cert.notAfter.value = args.notAfter ?? new Date(now.getTime() + 365 * 24 * 3600 * 1000);

  cert.subjectPublicKeyInfo.fromSchema(ber(args.subjectSpkiDer).result);

  cert.extensions = [];
  if (args.isCa) {
    const bc = new pkijs.BasicConstraints({ cA: true });
    cert.extensions.push(
      new pkijs.Extension({
        extnID: OID_BASIC_CONSTRAINTS,
        critical: true,
        extnValue: bc.toSchema().toBER(false),
        parsedValue: bc,
      }),
    );
  }
  if (args.isTsa) {
    // FINDINGS gotcha #5: the TSA leaf MUST carry the critical id-kp-timeStamping EKU.
    const eku = new pkijs.ExtKeyUsage({ keyPurposes: [OID_TSA_EKU] });
    cert.extensions.push(
      new pkijs.Extension({
        extnID: OID_EKU_EXT,
        critical: true,
        extnValue: eku.toSchema().toBER(false),
        parsedValue: eku,
      }),
    );
  }

  // The TBS and outer signatureAlgorithm must both name RSA-SHA256, then sign the TBS.
  cert.signature = new pkijs.AlgorithmIdentifier({
    algorithmId: OID_RSA_SHA256,
    algorithmParams: new asn1js.Null(),
  });
  cert.signatureAlgorithm = new pkijs.AlgorithmIdentifier({
    algorithmId: OID_RSA_SHA256,
    algorithmParams: new asn1js.Null(),
  });
  const tbs = toUint8(cert.encodeTBS().toBER(false));
  // pkijs caches the TBS bytes in `tbsView`; toSchema() re-emits from that cache, so it
  // must be seated for a manually-signed cert (cert.sign() does this internally).
  (cert as unknown as { tbsView: Uint8Array }).tbsView = tbs;
  const sig = nodeSign('sha256', Buffer.from(tbs), args.issuerPrivKey);
  cert.signatureValue = new asn1js.BitString({ valueHex: new Uint8Array(sig) });
  return cert;
}

/**
 * Synchronously verify an RFC 3161 TimeStampToken over `root`.
 *
 * Returns a boolean and NEVER throws (FINDINGS gotcha #3: an untrusted chain makes the
 * pkijs async verify THROW — we avoid that path entirely and wrap everything in try/catch).
 *
 * Checks: (1) the token is a CMS SignedData wrapping a TSTInfo; (2) the TSTInfo's
 * messageImprint is SHA-256 and its hashedMessage == SHA-256(root); (3) the SignerInfo
 * signature is RSA-PKCS1-v1.5 / SHA-256 and verifies under the embedded signer (leaf) cert.
 * Two CMS shapes are supported (I3): if the SignerInfo carries `signedAttrs`, the signature
 * is over the DER of the signedAttrs SET-OF (re-tagged 0x31), and the signed attributes must
 * carry message-digest == SHA-256(TSTInfo DER) and content-type == id-ct-TSTInfo (binding the
 * attrs to the actual content); if there are no signedAttrs, the signature is directly over
 * the TSTInfo DER (the local-CA case). (4) The leaf carries the id-kp-timeStamping EKU (I1)
 * and its validity window contains the token's genTime (I2). (5) The leaf chains to one of
 * `trustedCerts` — some embedded/trusted cert byte-matches a trusted cert AND issued (signed)
 * the leaf (or IS the leaf), and that issuer's validity window also contains genTime.
 */
export function verifyTimestampWithTime(
  root: Uint8Array,
  token: TimestampToken,
  trustedCerts: Uint8Array[],
): { ok: boolean; genTime?: Date } {
  try {
    const asn1 = ber(token.token);
    if (asn1.offset === -1) return { ok: false };

    const contentInfo = new pkijs.ContentInfo({ schema: asn1.result });
    if (contentInfo.contentType !== pkijs.id_ContentType_SignedData) return { ok: false };
    const signedData = new pkijs.SignedData({ schema: contentInfo.content });
    if (signedData.encapContentInfo.eContentType !== pkijs.id_eContentType_TSTInfo)
      return { ok: false };

    const eContent = signedData.encapContentInfo.eContent;
    if (!eContent) return { ok: false };
    const tstDer = extractEContentBytes(eContent);
    const tstInfo = new pkijs.TSTInfo({ schema: ber(tstDer).result });

    // (2) messageImprint == SHA-256(root), and the imprint hash algo is SHA-256.
    if (tstInfo.messageImprint.hashAlgorithm.algorithmId !== OID_SHA256) return { ok: false };
    const imprint = hexView(tstInfo.messageImprint.hashedMessage);
    const expected = imprintHash(root);
    if (imprint.length !== expected.length || !imprint.every((b, i) => b === expected[i])) {
      return { ok: false };
    }
    // FINDINGS gotcha #4: genTime is a pkijs `Time`; read `.value` for the JS Date.
    const genTime = tstInfo.genTime;
    if (!(genTime instanceof Date)) return { ok: false };

    const certs = (signedData.certificates ?? []).filter(
      (c): c is pkijs.Certificate => c instanceof pkijs.Certificate,
    );
    const signerInfo = signedData.signerInfos[0];
    if (!signerInfo) return { ok: false };
    const sid = signerInfo.sid;
    if (!(sid instanceof pkijs.IssuerAndSerialNumber)) return { ok: false };
    const wantSerial = Buffer.from(hexView(sid.serialNumber));
    const leaf = certs.find(
      (c) => Buffer.compare(Buffer.from(hexView(c.serialNumber)), wantSerial) === 0,
    );
    if (!leaf) return { ok: false };

    // (I1) The signer leaf MUST carry the id-kp-timeStamping EKU (RFC 3161 §2.3) — otherwise
    // any cert the trusted CA issued for any purpose could mint accepted timestamps.
    if (!certHasTsaEku(leaf)) return { ok: false };

    // (I2) genTime must fall within the leaf's validity window.
    if (!certValidAt(leaf, genTime)) return { ok: false };

    // (3) The SignerInfo signature is RSA-PKCS1-v1.5/SHA-256. Verify synchronously with
    // node:crypto. Two CMS shapes (I3):
    if (signerInfo.signatureAlgorithm.algorithmId !== OID_RSA_SHA256) return { ok: false };
    const sigBytes = Buffer.from(hexView(signerInfo.signature));
    const leafPubKey = publicKeyOf(leaf);
    if (signerInfo.signedAttrs) {
      // Signed-attrs path (real TSAs incl. freeTSA). The signature covers the signedAttrs
      // SET-OF DER. pkijs captures that DER in `signedAttrs.encodedValue` and has already
      // re-tagged the leading byte from the [0] IMPLICIT context tag to the SET-OF tag 0x31
      // (CMS/PKCS#7 rule), so it is exactly the bytes the signature was computed over.
      const signedAttrsDer = new Uint8Array(signerInfo.signedAttrs.encodedValue);
      if (signedAttrsDer.byteLength === 0 || signedAttrsDer[0] !== 0x31) return { ok: false };
      if (!nodeVerify('sha256', Buffer.from(signedAttrsDer), leafPubKey, sigBytes))
        return { ok: false };

      // Bind the signed attrs to the actual TSTInfo content:
      //   message-digest (1.2.840.113549.1.9.4) == SHA-256(tstDer)
      const md = findAttrOctetString(signerInfo.signedAttrs.attributes, OID_MESSAGE_DIGEST_ATTR);
      if (!md) return { ok: false };
      const tstHash = imprintHash(tstDer);
      if (md.length !== tstHash.length || !md.every((b, i) => b === tstHash[i]))
        return { ok: false };
      //   content-type (1.2.840.113549.1.9.3) == id-ct-TSTInfo
      const ct = findAttrOid(signerInfo.signedAttrs.attributes, OID_CONTENT_TYPE_ATTR);
      if (ct !== OID_CT_TSTINFO) return { ok: false };
    } else {
      // No signed attributes: the signature is directly over the TSTInfo DER (local-CA case).
      if (!nodeVerify('sha256', Buffer.from(tstDer), leafPubKey, sigBytes)) return { ok: false };
    }

    // (4) Chain to a trusted cert. The trust anchor may be EMBEDDED in the token (the
    // local-CA case embeds its CA) or supplied only in `trustedCerts` (a real TSA's
    // published CA, not necessarily embedded). Accept the leaf if, for any trusted cert:
    //   - it byte-matches the leaf (trusted self-signed leaf), OR
    //   - it (or an embedded cert byte-identical to it) issued the leaf — i.e. its public
    //     key verifies the leaf's TBS signature.
    const leafDer = Buffer.from(certDer(leaf));
    for (const trustedDer of trustedCerts) {
      const tBuf = Buffer.from(trustedDer);
      if (Buffer.compare(tBuf, leafDer) === 0) return { ok: true, genTime }; // trusted self-signed leaf
      const trustedCert = parseCert(trustedDer);
      // (I2) the issuing CA's validity window must also contain genTime.
      if (trustedCert && certValidAt(trustedCert, genTime) && certSignedBy(leaf, trustedCert)) {
        return { ok: true, genTime };
      }
    }
    // Also walk one embedded hop: an embedded intermediate that is itself trusted (byte
    // match) and issued the leaf. (Covers a trusted intermediate embedded alongside the leaf.)
    for (const cand of certs) {
      const candDer = Buffer.from(certDer(cand));
      if (!trustedCerts.some((t) => Buffer.compare(Buffer.from(t), candDer) === 0)) continue;
      if (certValidAt(cand, genTime) && certSignedBy(leaf, cand)) return { ok: true, genTime };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Back-compat boolean wrapper (unchanged contract for makeVerifyTimestamp + importers). */
export function verifyTimestamp(
  root: Uint8Array,
  token: TimestampToken,
  trustedCerts: Uint8Array[],
): boolean {
  return verifyTimestampWithTime(root, token, trustedCerts).ok;
}

/** Parse an X.509 DER cert; returns undefined (never throws) on malformed input. */
function parseCert(der: Uint8Array): pkijs.Certificate | undefined {
  try {
    const asn1 = ber(der);
    if (asn1.offset === -1) return undefined;
    return new pkijs.Certificate({ schema: asn1.result });
  } catch {
    return undefined;
  }
}

/** True iff `issuer`'s public key verifies `subject`'s certificate signature (one chain hop). */
function certSignedBy(subject: pkijs.Certificate, issuer: pkijs.Certificate): boolean {
  try {
    if (subject.signatureAlgorithm.algorithmId !== OID_RSA_SHA256) return false;
    const tbs = toUint8(subject.encodeTBS().toBER(false));
    const sig = Buffer.from(hexView(subject.signatureValue));
    return nodeVerify('sha256', Buffer.from(tbs), publicKeyOf(issuer), sig);
  } catch {
    return false;
  }
}

/** I1: true iff `cert` carries the EKU extension (2.5.29.37) containing id-kp-timeStamping. */
function certHasTsaEku(cert: pkijs.Certificate): boolean {
  const ext = (cert.extensions ?? []).find((e) => e.extnID === OID_EKU_EXT);
  if (!ext) return false;
  // parsedValue may not be populated when the cert came off the wire; parse the extnValue.
  let eku = ext.parsedValue as pkijs.ExtKeyUsage | undefined;
  if (!(eku instanceof pkijs.ExtKeyUsage)) {
    const asn1 = ber(new Uint8Array(ext.extnValue.valueBlock.valueHexView));
    if (asn1.offset === -1) return false;
    eku = new pkijs.ExtKeyUsage({ schema: asn1.result });
  }
  return eku.keyPurposes.includes(OID_TSA_EKU);
}

/** I2: true iff `at` falls within the cert's notBefore..notAfter validity window. */
function certValidAt(cert: pkijs.Certificate, at: Date): boolean {
  const notBefore = cert.notBefore.value;
  const notAfter = cert.notAfter.value;
  if (!(notBefore instanceof Date) || !(notAfter instanceof Date)) return false;
  return at.getTime() >= notBefore.getTime() && at.getTime() <= notAfter.getTime();
}

/** Find a CMS Attribute by OID and return its first value as raw bytes (e.g. message-digest). */
function findAttrOctetString(attrs: pkijs.Attribute[], oid: string): Uint8Array | undefined {
  const attr = attrs.find((a) => a.type === oid);
  const v = attr?.values?.[0] as { valueBlock?: { valueHexView?: Uint8Array } } | undefined;
  if (!v?.valueBlock?.valueHexView) return undefined;
  return new Uint8Array(v.valueBlock.valueHexView);
}

/** Find a CMS Attribute by OID and return its first value as an OID string (e.g. content-type). */
function findAttrOid(attrs: pkijs.Attribute[], oid: string): string | undefined {
  const attr = attrs.find((a) => a.type === oid);
  const v = attr?.values?.[0] as asn1js.ObjectIdentifier | undefined;
  if (!(v instanceof asn1js.ObjectIdentifier)) return undefined;
  return v.valueBlock.toString();
}

/**
 * Mint a real RFC 3161 TimeStampToken signed by a freshly self-generated test CA.
 * The trusted-time analogue of `LocalAnchor` — for offline tests and demos. Each
 * instance owns one CA + one TSA leaf (generated synchronously in the constructor);
 * `caCertDer` is the trust root to pass to `verifyTimestamp`.
 */
export interface LocalCaTimestampAuthorityOptions {
  /** Emit CMS signed attributes (content-type + message-digest), as real TSAs do. Default
   *  off so the historical no-attrs happy-path is unchanged. Exercises the I3 verify path. */
  signedAttrs?: boolean;
  /** Whether the TSA leaf carries the id-kp-timeStamping EKU. Default true. Set false to
   *  mint a non-TSA leaf (negative control for the I1 EKU enforcement). */
  tsaEku?: boolean;
  /** Override the TSA leaf's validity window (negative control for the I2 genTime check). */
  leafNotBefore?: Date;
  leafNotAfter?: Date;
}

export class LocalCaTimestampAuthority implements TimestampAuthority {
  readonly id = 'local-ca-tsa';

  /** DER of this authority's CA certificate — the trust root for `verifyTimestamp`. */
  readonly caCertDer: Uint8Array;

  private readonly caCert: pkijs.Certificate;
  private readonly tsaCert: pkijs.Certificate;
  private readonly tsaPrivKey: KeyObject;
  private readonly emitSignedAttrs: boolean;
  private serial = 0;

  constructor(opts: LocalCaTimestampAuthorityOptions = {}) {
    this.emitSignedAttrs = opts.signedAttrs ?? false;
    const ca = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.caCert = buildCertSync({
      subjectCN: 'Pangolin Local TSA Test CA',
      issuerCN: 'Pangolin Local TSA Test CA',
      subjectSpkiDer: new Uint8Array(ca.publicKey.export({ type: 'spki', format: 'der' })),
      issuerPrivKey: ca.privateKey,
      serial: 1,
      isCa: true,
    });

    const tsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.tsaPrivKey = tsa.privateKey;
    this.tsaCert = buildCertSync({
      subjectCN: 'Pangolin Local TSA',
      issuerCN: 'Pangolin Local TSA Test CA',
      subjectSpkiDer: new Uint8Array(tsa.publicKey.export({ type: 'spki', format: 'der' })),
      issuerPrivKey: ca.privateKey, // signed BY the CA
      serial: 2,
      isTsa: opts.tsaEku ?? true,
      notBefore: opts.leafNotBefore,
      notAfter: opts.leafNotAfter,
    });

    this.caCertDer = certDer(this.caCert);
  }

  async timestamp(rootHash: Uint8Array): Promise<TimestampToken> {
    // messageImprint = SHA-256(rootHash) — matching what verifyTimestamp recomputes.
    const messageImprint = imprintHash(rootHash);
    const genTime = new Date();
    const tstInfo = new pkijs.TSTInfo({
      version: 1,
      policy: '1.2.3.4.1',
      messageImprint: new pkijs.MessageImprint({
        hashAlgorithm: new pkijs.AlgorithmIdentifier({
          algorithmId: OID_SHA256,
          algorithmParams: new asn1js.Null(),
        }),
        hashedMessage: new asn1js.OctetString({ valueHex: messageImprint }),
      }),
      serialNumber: new asn1js.Integer({ value: ++this.serial }),
      genTime,
    });
    const tstInfoDer = toUint8(tstInfo.toSchema().toBER(false));

    const signerInfo = new pkijs.SignerInfo({
      version: 1,
      sid: new pkijs.IssuerAndSerialNumber({
        issuer: this.tsaCert.issuer,
        serialNumber: this.tsaCert.serialNumber,
      }),
      digestAlgorithm: new pkijs.AlgorithmIdentifier({
        algorithmId: OID_SHA256,
        algorithmParams: new asn1js.Null(),
      }),
      signatureAlgorithm: new pkijs.AlgorithmIdentifier({
        algorithmId: OID_RSA_SHA256,
        algorithmParams: new asn1js.Null(),
      }),
    });

    if (this.emitSignedAttrs) {
      // CMS signed-attrs path: build content-type + message-digest attributes, sign over the
      // SET-OF DER encoding (tag 0x31), and attach as the [0] IMPLICIT signedAttrs. Mirrors
      // exactly what a real RFC 3161 TSA (incl. freeTSA) emits and what verifyTimestamp checks.
      const attrs = [
        new pkijs.Attribute({
          type: OID_CONTENT_TYPE_ATTR,
          values: [new asn1js.ObjectIdentifier({ value: OID_CT_TSTINFO })],
        }),
        new pkijs.Attribute({
          type: OID_MESSAGE_DIGEST_ATTR,
          values: [new asn1js.OctetString({ valueHex: imprintHash(tstInfoDer) })],
        }),
      ];
      // The signature covers the SET-OF encoding (tag 0x31), NOT the [0] IMPLICIT tag.
      const setOfDer = toUint8(
        new asn1js.Set({ value: attrs.map((a) => a.toSchema()) }).toBER(false),
      );
      const signature = nodeSign('sha256', Buffer.from(setOfDer), this.tsaPrivKey);
      signerInfo.signedAttrs = new pkijs.SignedAndUnsignedAttributes({
        type: 0,
        attributes: attrs,
      });
      signerInfo.signature = new asn1js.OctetString({ valueHex: new Uint8Array(signature) });
    } else {
      // No signed attributes: sign the eContent (the TSTInfo DER) directly.
      const signature = nodeSign('sha256', Buffer.from(tstInfoDer), this.tsaPrivKey);
      signerInfo.signature = new asn1js.OctetString({ valueHex: new Uint8Array(signature) });
    }

    const signedData = new pkijs.SignedData({
      version: 3,
      encapContentInfo: new pkijs.EncapsulatedContentInfo({
        eContentType: pkijs.id_eContentType_TSTInfo,
        eContent: new asn1js.OctetString({ valueHex: tstInfoDer }),
      }),
      signerInfos: [signerInfo],
      certificates: [this.tsaCert, this.caCert],
    });

    const tokenDer = toUint8(
      new pkijs.ContentInfo({
        contentType: pkijs.id_ContentType_SignedData,
        content: signedData.toSchema(true),
      })
        .toSchema()
        .toBER(false),
    );

    return { alg: 'rfc3161', token: tokenDer, at: genTime.toISOString() };
  }
}

/**
 * RFC 3161 client for a real network TSA. POSTs a TimeStampReq to `url` and returns the
 * token from the TimeStampResp. (Network path; unit-tested only via the local-CA above —
 * a live TSA is exercised in the spike's optional SPIKE_NETWORK=1 mode.)
 */
export class Rfc3161TimestampAuthority implements TimestampAuthority {
  readonly id: string;
  private readonly url: string;

  constructor(opts: { url: string }) {
    this.url = opts.url;
    this.id = `rfc3161:${opts.url}`;
  }

  async timestamp(rootHash: Uint8Array): Promise<TimestampToken> {
    const imprint = imprintHash(rootHash);
    const req = new pkijs.TimeStampReq({
      version: 1,
      messageImprint: new pkijs.MessageImprint({
        hashAlgorithm: new pkijs.AlgorithmIdentifier({
          algorithmId: OID_SHA256,
          algorithmParams: new asn1js.Null(),
        }),
        hashedMessage: new asn1js.OctetString({ valueHex: imprint }),
      }),
      certReq: true, // ask the TSA to embed its cert chain so the token is self-contained
    });
    const reqDer = toUint8(req.toSchema().toBER(false));
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query' },
      body: Buffer.from(reqDer),
    });
    if (!resp.ok) {
      throw new Error(`TSA ${this.url} responded ${resp.status} ${resp.statusText}`);
    }
    const tsrBytes = new Uint8Array(await resp.arrayBuffer());
    const tsr = new pkijs.TimeStampResp({ schema: ber(tsrBytes).result });
    const status = tsr.status.status;
    if (status !== 0 && status !== 1) {
      throw new Error(`TSA ${this.url} PKIStatus ${status} (not granted)`);
    }
    if (!tsr.timeStampToken) {
      throw new Error(`TSA ${this.url} returned no timeStampToken`);
    }
    const tokenDer = toUint8(tsr.timeStampToken.toSchema().toBER(false));
    return { alg: 'rfc3161', token: tokenDer, at: new Date().toISOString(), tsaUrl: this.url };
  }
}
