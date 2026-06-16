---
title: Trust root
description: The published, static public-key manifest the verifier uses to resolve signing keys — what it contains, how operators generate and publish it, and its rotation and revocation lifecycle.
sidebar:
  order: 8
---

The trust root is a published, static, **public** JSON file that maps stable key
identifiers (`keyRef`) to public-key material and a lifecycle status. It is the
mechanism by which an auditor or verifier knows *which* key was used to sign a
bundle — and whether that key was valid at the time of signing.

It contains **only** public keys. No secrets. No live service. It runs nothing; the
verifier reads it.

## What it is not

The trust root is distinct from the **WORM anchor** (the S3 Object Lock bucket that
holds the Merkle root hash for tamper-evidence). The two defend different things:

| | WORM anchor | Trust root |
|---|---|---|
| Holds | Merkle **root hash** | Signing **public key(s)** |
| Proves | The ledger was not altered after sealing | Which key signed a bundle, and whether it was valid |
| Written | At seal time (live write) | Out-of-band by the operator |
| Read by | Verifier, over the wire | Auditor-supplied to the verifier |

## JSON shape

```json
{
  "schemaVersion": 1,
  "keys": {
    "pangolin-prod-2026": {
      "alg": "ecdsa-p256",
      "spkiDer": "<base64 SPKI-DER from KMS GetPublicKey>",
      "status": "active",
      "notBefore": "2026-07-01T00:00:00Z",
      "notAfter": null,
      "revokedAt": null
    }
  }
}
```

All timestamps are strict ISO-8601 with an explicit `Z` or `+/-hh:mm` offset
(`parseTrustRoot` rejects any timestamp that lacks one). `notAfter` and `revokedAt`
are `null` when not set.

The TypeScript interface is `TrustRoot` / `TrustRootKey` exported from
`@quarry-systems/pangolin-verify`.

## How operators generate entries

Use `publishablePublicKey` from `@quarry-systems/pangolin-signer-aws-kms`:

```typescript
import { publishablePublicKey } from '@quarry-systems/pangolin-signer-aws-kms';

const entry = await publishablePublicKey({
  keyId: 'arn:aws:kms:us-east-1:123456789012:key/...',
  keyRef: 'pangolin-prod-2026',
  region: 'us-east-1',
});

// entry = { keyRef, alg: 'ecdsa-p256', spkiDer: '<base64>' }
// Drop entry into your trust-root manifest, under keys[entry.keyRef].
```

`publishablePublicKey` calls KMS `GetPublicKey`, encodes the returned SPKI-DER as
base64, and returns a manifest-ready object. **Never hand-encode key material** — let
KMS produce it.

## Publication channel

The load-bearing rule is: **the auditor obtains the trust-root file through a channel
they already trust**, and **the verifier resolves keys from it — never from the audit
bundle**. A bundle-supplied key is self-attesting: a forger would simply ship their
own key alongside a matching signature. That is the same forgery class the
earliest-version anchor read and required-signature check close on the tamper-evidence
side.

Acceptable channels (choose one or more):

- **TLS docs site** — the simplest option; the auditor fetches the URL they bookmarked,
  not a URL inside the bundle.
- **Signed git tag** — a tag signed by a known GPG/SSH key, pinned by fingerprint in
  your runbook.
- **CDN object** — versioned, immutable URL distributed to auditors in advance.
- **Direct handoff** — for air-gapped environments, a physical or offline-signed copy.

Optional hardening: a detached signature over the whole manifest by an offline root
key, with the public fingerprint pinned in your runbook or this docs site. Auditors
verify the detached signature before trusting the manifest entries.

## Using the trust root in the verifier

```typescript
import { parseTrustRoot, makeVerifySignatureFromTrustRoot } from '@quarry-systems/pangolin-verify';

// 1. Fetch the manifest through your trusted channel (not from the bundle).
const json = await fetch('https://your-docs-site.example/trust-root.json').then(r => r.text());
const trustRoot = parseTrustRoot(json); // throws on malformed input — fail closed

// 2. Build a verifySignature function bound to this trust root.
const verifySignature = makeVerifySignatureFromTrustRoot(trustRoot, genTime);
//    genTime: the RFC-3161 verified timestamp if present, otherwise undefined.
//    When present, revocation and validity-window checks use it.

// 3. Pass to VerifyContext (or the orch export in pangolin.config.mjs).
```

`parseTrustRoot` is strict: it rejects unknown `alg` values, missing `spkiDer`,
invalid status strings, and any timestamp that does not match strict ISO-8601.

## Lifecycle

### Rotation

Add a new entry to the manifest with `status: "active"` and `notBefore` set to the
cutover time. Keep the old entry in place — bundles sealed under the old key remain
verifiable. Do **not** remove old entries.

```json
{
  "schemaVersion": 1,
  "keys": {
    "pangolin-prod-2025": {
      "alg": "ecdsa-p256",
      "spkiDer": "<old key>",
      "status": "active",
      "notBefore": "2025-01-01T00:00:00Z",
      "notAfter": "2026-07-01T00:00:00Z",
      "revokedAt": null
    },
    "pangolin-prod-2026": {
      "alg": "ecdsa-p256",
      "spkiDer": "<new key>",
      "status": "active",
      "notBefore": "2026-07-01T00:00:00Z",
      "notAfter": null,
      "revokedAt": null
    }
  }
}
```

The verifier enforces the `notBefore`/`notAfter` window when a verified `genTime`
exists (RFC-3161 `tsa-attested` tier). Without a trusted genTime, the window is not
enforced.

### Revocation

Set `status` to `"revoked"` and fill in `revokedAt`. A bundle whose signature was
made under a revoked key **fails** verification — **unless** a trusted (`tsa-attested`)
RFC-3161 timestamp proves the bundle was signed strictly before `revokedAt`. Without
that trusted timestamp, revocation is a hard block regardless of claimed sign time.

```json
"pangolin-prod-2025": {
  "alg": "ecdsa-p256",
  "spkiDer": "<compromised key>",
  "status": "revoked",
  "notBefore": "2025-01-01T00:00:00Z",
  "notAfter": null,
  "revokedAt": "2026-03-15T12:00:00Z"
}
```

## Honesty bound

The trust root + KMS custody is the *designed* production answer. Today's `createLocalSigner`
signs with a **local, ephemeral key** — so a demo bundle's signature is demo-grade and should
be described as such alongside the tamper tier.

Even in production:

- **KMS custody** stops private key exfiltration and enables rotation and revocation.
- **KMS custody does not** stop an operator who legitimately holds signing access from signing
  a false record. That remains a non-goal defended by the anchor + chain, not the key.

State the key tier explicitly alongside the tamper tier whenever you present audit results.
