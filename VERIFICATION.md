# Verifying a Pangolin Scale audit bundle

This document specifies — sufficient to reimplement WITHOUT reading the code — how to
independently verify a Pangolin Scale **audit bundle**: the self-contained evidence
artifact a run emits. The whole point of the bundle is *trust the artifact, not the
vendor*: an auditor runs `pangolin-verify bundle.json` (the standalone
`@quarry-systems/pangolin-verify` package, which carries its own ASN.1/CMS dependency)
and gets a verdict without installing the orchestrator that produced it.

There is **one** verification algorithm. The two assurance *modes* (offline vs
anchor-checked) differ only in **which root the verifier compares against** — they are
parametrized by the anchor source, not by a forked code path.

---

## 1. The `AuditBundle` JSON shape

A bundle is a single JSON object. Binary fields (Merkle roots, signature bytes, RFC 3161
token bytes) are **base64** strings in JSON; everything else is plain JSON.

```jsonc
{
  "runId": "run-2026-06-12-abc",         // the run this bundle attests
  "manifests": [                          // one per fired work item (DispatchManifest)
    {
      "schemaVersion": 1,
      "runId": "run-2026-06-12-abc",
      "itemId": "appeal-001",
      "parent": "run:run-2026-06-12-abc",
      "executor": "dispatch",
      "executorManifest": { /* opaque, content-hashed; dispatch seals { model:{id} } */ },
      "secretRefs": [],                   // REFERENCES only — never secret values
      "actor": "human:alice",
      "inputRefs": { "spec": "sha256:..." },  // typed-product handoff: input key -> upstream product ref
      "firedAt": "2026-06-12T10:00:00Z",
      "manifestHash": "sha256:...",       // self-hash over the fields above
      "signature": { "alg": "...", "bytes": "<base64>", "keyRef": "..." } // optional
    }
  ],
  "auditLog": {
    "entries": [                          // the hash-linked ledger, ordered by seq
      {
        "runId": "run-2026-06-12-abc",
        "seq": 0,                         // 0-based, contiguous, no gaps
        "kind": "run.submitted",          // run.submitted | item.fired | item.reconciled | ...
        "itemId": "appeal-001",           // optional
        "status": "done",                 // optional
        "actor": "human:alice",           // optional
        "manifestRef": "sha256:...",      // optional, content hash
        "resultRef": "sha256:...",        // optional, content hash
        "at": "2026-06-12T10:00:00Z",     // ISO-8601
        "entryHash": "<hex>",             // chainHash(canonEntry(this), prevHash)
        "prevHash": "<hex>"               // == previous entry's entryHash; "" for seq 0
      }
    ],
    "root": {                             // the AnchoredRoot — undefined if the run never sealed
      "epochId": "run-2026-06-12-abc",    // == runId (the audit epoch is the run)
      "root": "<base64>",                 // the Merkle root over all entry hashes
      "signature": {                      // optional ed25519 signature over `root`
        "alg": "ed25519",
        "bytes": "<base64>",
        "keyRef": "..."                   // optional key identifier
      },
      "receipt": {                        // anchor receipt
        "anchorId": "s3:my-bucket",
        "epochId": "run-2026-06-12-abc",
        "guarantee": "external-immutable", // detect | external-immutable | witnessed
        "at": 1718185200000,
        "locator": "s3://my-bucket/audit/roots/run-2026-06-12-abc.json" // optional
      },
      "timestamp": {                      // optional RFC 3161 trusted-time evidence
        "alg": "rfc3161",
        "token": "<base64>",              // DER RFC 3161 TimeStampToken (CMS SignedData)
        "at": "2026-06-12T10:00:05Z",     // TSA-asserted time, DISPLAY ONLY
        "tsaUrl": "https://freetsa.org/tsr" // optional
      }
    }
  },
  "items": [                              // per-item outcome rows — references only
    {
      "id": "appeal-001",
      "status": "done",
      "attempts": 1,
      "actor": "agent:charmander",
      "resultRef": "sha256:...",          // the deliverable this item produced
      "manifestRef": "sha256:...",
      "outputRefs": { "outputs/report.md": "sha256:..." } // producer-side handoff refs
    }
  ],
  "report": { /* the VerificationReport the producer computed; recomputed by the verifier */ }
}
```

The verifier **recomputes** `report` from scratch; it does not trust the embedded one.

---

## 2. The verify context

The verifier needs material the bundle deliberately does **not** carry inline (so the
bundle cannot self-certify a forged anchor). This is a separate JSON file passed via
`--anchor <verify-context.json>`. Binary fields are **base64**.

```jsonc
{
  // ed25519 PUBLIC key as SubjectPublicKeyInfo DER (SPKI-DER), base64.
  // Used to verify auditLog.root.signature. Optional — omit to skip the signature check.
  "signerPublicKeySpkiDer": "<base64>",

  // The anchor source. EXACTLY ONE of the two shapes below:

  // (a) OFFLINE — inline the AnchoredRoot the producer claims. The verifier's anchor
  //     simply re-serves bundle.auditLog.root. Claim ceiling: tamper-detecting.
  //     (Inlining the root proves nothing the bundle didn't already say; it only
  //      lets you detect internal inconsistency — chain/merkle drift.)
  "anchor": { "mode": "offline" },

  // (b) ANCHOR-CHECKED — point at the external WORM (S3 Object-Lock) record. The
  //     verifier fetches the REAL root from immutable storage and compares. Claim
  //     ceiling: tamper-evident (when guarantee >= external-immutable and intact).
  "anchor": {
    "mode": "anchor-checked",
    "s3": {
      "bucket": "my-audit-bucket",
      "key": "audit/roots/run-2026-06-12-abc.json", // optional; default audit/roots/<epochId>.json
      // ... credentials/region as the S3 client impl requires
    }
  },

  // Optional: trusted TSA CA certificate(s), each base64 DER (X.509). Used to verify
  // auditLog.root.timestamp. Omit (or empty) to skip the time check (timeTier=asserted).
  "tsaCaCertsDer": ["<base64>", "..."]
}
```

The S3 record at `audit/roots/<epochId>.json` is the JSON the `S3ObjectLockAnchor`
wrote: `{ epochId, rootHex, signature?, receipt }` (root is **hex** in that record, not
base64 — it is an internal storage detail, not the bundle wire format).

---

## 3. The verification algorithm

Given a `bundle` and a built `anchor` (read-only, see §4), plus optional
`verifySignature` and `verifyTimestamp` callbacks:

1. **Chain.** Walk `auditLog.entries` in order. For each entry at index `i`:
   - assert `entry.seq === i` (contiguous, no gaps — catches a deleted-and-relinked entry);
   - recompute `chainHash(canonEntry(entry), prevHash)` and assert it equals `entry.entryHash`;
   - assert `entry.prevHash` equals the previous entry's `entryHash` (`""` for `seq 0`).
   Stop at the first broken link (later links are meaningless once the chain is cut).
   `canonEntry` is a **positional JSON array** with a pinned field order — NOT key-sorted
   JSON / JCS — namely `[kind, runId, itemId, status, actor, manifestRef, resultRef, at, seq]`,
   with absent optionals serialized as `null` (excludes `entryHash`/`prevHash`).
   `chainHash(canon, prev) = SHA-256(canon || prev)` (the canonical bytes, then the prev hash).

2. **Merkle root.** Recompute the Merkle root over the ordered list of `entryHash`es
   (binary Merkle tree, SHA-256). An odd trailing node at a level is **carried up unhashed**
   (NOT duplicated) — `merkleRoot(leavesFromEntryHashes(...))`.

3. **Anchor fetch.** Fetch the anchored root for this `epochId` (== `runId`) from the
   anchor source. If nothing is returned → `anchor` check fails (`anchor-missing`).

4. **Root compare.** Assert the recomputed Merkle root (step 2) byte-equals the fetched
   anchored root. Mismatch → `root-mismatch`. **This is the load-bearing comparison**:
   in offline mode the fetched root is the bundle's own claim (detects internal drift);
   in anchor-checked mode it is the immutable external record (detects post-hoc tampering).

5. **Signature** (optional). If the anchored root carries a `signature` and a
   `verifySignature` callback is present, verify the ed25519 signature over the root
   bytes using the context's SPKI-DER public key. Failure → `signature`. Absent
   signature or callback → `n/a` (not a failure).

6. **Trusted time** (optional, INFORMATIONAL). If the anchored root carries a
   `timestamp` and a `verifyTimestamp` callback is present, verify the RFC 3161 token:
   - parse the CMS `SignedData` from `timestamp.token`; locate the signer (leaf) cert by
     the SignerInfo's IssuerAndSerialNumber;
   - assert the TSTInfo `messageImprint.hashedMessage == SHA-256(root)` and the imprint
     hash algorithm is SHA-256;
   - assert the leaf cert carries the Extended Key Usage `id-kp-timeStamping`
     (`1.3.6.1.5.5.7.3.8`, ext OID `2.5.29.37`) — RFC 3161 §2.3, so only a designated TSA
     cert can mint accepted timestamps;
   - assert the token's `genTime` falls within the leaf cert's validity window (and within
     the issuing CA cert's window for the hop that establishes trust);
   - verify the SignerInfo signature (RSA-PKCS1-v1.5 / SHA-256 only) under the leaf cert.
     Two CMS shapes are accepted:
       - **No signed attributes** — the signature is directly over the TSTInfo DER
         (the `eContent`). (The local-CA offline-demo token uses this shape.)
       - **Signed attributes present** (real TSAs, incl. freeTSA) — the signature is over
         the DER encoding of the `signedAttrs` SET re-tagged with the explicit SET-OF tag
         `0x31` (CMS/PKCS#7: the signature covers the SET-OF form, not the `[0] IMPLICIT`
         tag as it appears in the SignerInfo). The signed attributes MUST carry a
         `message-digest` attribute (`1.2.840.113549.1.9.4`) equal to `SHA-256(TSTInfo DER)`
         and a `content-type` attribute (`1.2.840.113549.1.9.3`) equal to id-ct-TSTInfo
         (`1.2.840.113549.1.9.16.1.4`). This preserves the binding chain
         root → messageImprint → message-digest attr → signed attrs.
   - validate the signer certificate chains to one of the trusted TSA CA certs (byte-match
     to the leaf, or the trusted CA's public key verifies the leaf's TBS signature).
   On success `timeTier = tsa-attested`; otherwise `asserted`. A failed time check is
   **informational only** — it never gates `intact`, never sets `failure`, never lowers
   the tamper `claim`. (Trusted time is a *separate assurance dimension* from tamper.)

7. **Handoff closure.** Every `manifests[*].inputRefs` value must equal some completed
   (`status === "done"`) item's `resultRef` or one of its `outputRefs` values. Refs are
   SHA-256 content hashes, so ref-equality **is** byte-equality (no blob fetching). A
   dangling input ref → `handoff` failure.

**Verdict.** `intact = chain && anchor && root!==false && signature!==false && handoff!==false`.
`failure` is the FIRST failing check in the order: chain, anchor-missing, root-mismatch,
signature, handoff. (There is no `time` failure variant.)

---

## 4. The two modes and their claim ceilings

The tamper `claim` is derived by one rule (`claimFor`): **tamper-evident** iff `intact`
AND the anchor guarantee rank is `>= external-immutable`; otherwise **tamper-detecting**.

| Mode | Anchor source | Anchor guarantee | Claim ceiling |
|------|---------------|------------------|---------------|
| `offline` | inline `bundle.auditLog.root`, re-served | `detect` | **tamper-detecting** |
| `anchor-checked` | external S3 Object-Lock (WORM) record | `external-immutable` | **tamper-evident** |

- **offline** answers "is this bundle internally consistent?" — the recomputed chain and
  Merkle root match the root the bundle itself claims. It cannot catch an attacker who
  rewrote the whole bundle (chain, root, and report together) because there is no
  external witness. Hence the ceiling is *tamper-detecting*: you can detect accidental or
  partial tampering, but the root of trust is the bundle producer.

- **anchor-checked** answers "does this bundle match what was committed to immutable
  storage at seal time?" — the recomputed Merkle root must equal the root in the S3
  Object-Lock (COMPLIANCE-mode, WORM) record, which the producer could not have rewritten
  after the fact. Hence the ceiling is *tamper-evident*: tampering is provable against an
  external, vendor-independent witness.

Trusted time (§3 step 6) rides orthogonally on either mode: present a TSA CA cert and the
report reads `tsa-attested`; omit it and the report reads `asserted`. It never changes the
tamper claim.

---

## 5. Reference implementation

`@quarry-systems/pangolin-verify` implements all of the above. The chain/Merkle/compare/
signature/handoff logic lives in `@quarry-systems/pangolin-core` (`verifyBundle`), which
accepts injected `verifySignature`/`verifyTimestamp` callbacks; `pangolin-verify` supplies
the ed25519 (`node:crypto`) and RFC 3161 (pkijs/asn1js) implementations and the two anchor
sources. The same `verifyTimestamp` verifies both a self-minted local-CA token (for
offline demos) and a real third-party TSA token (e.g. freeTSA).
