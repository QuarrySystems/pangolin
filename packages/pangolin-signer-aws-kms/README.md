# @quarry-systems/pangolin-signer-aws-kms

AWS KMS asymmetric ECDSA-P256 signer for the Pangolin audit seal. Implements the `Signer` seam from `@quarry-systems/pangolin-core` — sole owner of `@aws-sdk/client-kms` so that `pangolin-core` and `pangolin-verify` remain SDK-free.

## Install

```bash
pnpm add @quarry-systems/pangolin-signer-aws-kms
```

## Usage

```ts
import { createKmsSigner, publishablePublicKey } from '@quarry-systems/pangolin-signer-aws-kms';

// Inject as the audit seal's Signer — the private key never leaves KMS:
const signer = createKmsSigner({
  keyId: 'arn:aws:kms:us-east-1:…:key/…', // a KMS ECC_NIST_P256 key (SIGN_VERIFY)
  keyRef: 'pangolin-prod-2026',            // stable id sealed into the signature + published in the trust root
});

// Publish the matching PUBLIC key as a trust-root manifest entry (run once per key):
const entry = await publishablePublicKey({ keyId: 'arn:aws:kms:…', keyRef: 'pangolin-prod-2026' });
// → { keyRef: 'pangolin-prod-2026', alg: 'ecdsa-p256', spkiDer: '<base64 SPKI-DER>' }
```

The verifier resolves signatures against the published trust root by `keyRef` — see the
[trust-root reference](https://quarrysystems.github.io/pangolin/reference/trust-root/) for
publication, rotation, and revocation.

## Spec

- [ADR-0001 — Package scope](https://quarrysystems.github.io/pangolin/explanation/decisions/0001-package-scope/): the `@quarry-systems/pangolin-*` namespace this package publishes under.
