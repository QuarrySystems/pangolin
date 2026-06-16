// @quarry-systems/pangolin-signer-aws-kms
// AWS KMS asymmetric ECDSA-P256 signer behind the core `Signer` seam.
// SOLE owner of @aws-sdk/client-kms; pangolin-core/pangolin-verify gain no SDK dependency.
import { KMSClient, SignCommand, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import type { Signer, Signature } from '@quarry-systems/pangolin-core';

export interface KmsSignerOptions {
  /** KMS key ARN/alias used for the Sign call (AWS-internal locator). */
  keyId: string;
  /** Stable audit-facing public identifier sealed into Signature.keyRef and resolved
   *  against the published trust root. Distinct from keyId on purpose. */
  keyRef: string;
  region?: string;
  /** Inject a client (tests). Defaults to a real KMSClient. */
  client?: Pick<KMSClient, 'send'>;
}

/** Production signer: KMS ECC_NIST_P256 / ECDSA_SHA_256 over the raw 32-byte root.
 *  KMS hashes the message with SHA-256 (MessageType RAW) and returns a DER ECDSA sig —
 *  byte-compatible with the verifier. The private key never leaves KMS. */
export function createKmsSigner(opts: KmsSignerOptions): Signer {
  const client = opts.client ?? new KMSClient(opts.region ? { region: opts.region } : {});
  return {
    keyRef: opts.keyRef,
    async sign(root: Uint8Array): Promise<Signature> {
      const out = await client.send(
        new SignCommand({
          KeyId: opts.keyId,
          Message: root,
          MessageType: 'RAW',
          SigningAlgorithm: 'ECDSA_SHA_256',
        }) as never,
      );
      const der = (out as { Signature?: Uint8Array }).Signature;
      if (!der) throw new Error('KMS Sign returned no Signature');
      return { alg: 'ecdsa-p256', bytes: new Uint8Array(der), keyRef: opts.keyRef };
    },
  };
}

export interface PublishableKey {
  keyRef: string;
  alg: 'ecdsa-p256';
  /** base64 SPKI-DER, ready to drop into a trust-root manifest entry. */
  spkiDer: string;
}

/** Fetch the KMS public key (SPKI-DER) and shape it as a trust-root manifest entry.
 *  Operators run this to publish key material — never hand-encode it. */
export async function publishablePublicKey(opts: {
  keyId: string;
  keyRef: string;
  region?: string;
  client?: Pick<KMSClient, 'send'>;
}): Promise<PublishableKey> {
  const client = opts.client ?? new KMSClient(opts.region ? { region: opts.region } : {});
  const out = await client.send(new GetPublicKeyCommand({ KeyId: opts.keyId }) as never);
  const spki = (out as { PublicKey?: Uint8Array }).PublicKey;
  if (!spki) throw new Error('KMS GetPublicKey returned no PublicKey');
  return { keyRef: opts.keyRef, alg: 'ecdsa-p256', spkiDer: Buffer.from(spki).toString('base64') };
}
