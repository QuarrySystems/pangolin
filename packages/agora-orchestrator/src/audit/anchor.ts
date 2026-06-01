import type { AuditAnchor, AnchorReceipt, AnchoredRoot, Signature, AuditStore } from '../contracts/index.js';

export class LocalAnchor implements AuditAnchor {
  readonly id = 'local';
  readonly guarantee = 'detect' as const;

  constructor(
    private readonly store: AuditStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async anchor(epoch: { epochId: string; root: Uint8Array; signature?: Signature }): Promise<AnchorReceipt> {
    const receipt: AnchorReceipt = {
      anchorId: this.id,
      epochId: epoch.epochId,
      guarantee: this.guarantee,
      at: this.now(),
    };
    this.store.putAuditRoot({ epochId: epoch.epochId, root: epoch.root, signature: epoch.signature, receipt });
    return receipt;
  }

  async fetch(range: { epochId?: string }): Promise<AnchoredRoot[]> {
    const r = range.epochId ? this.store.getAuditRoot(range.epochId) : undefined;
    return r ? [r] : [];
  }
}

/** Minimal injected S3 seam — keeps the orchestrator dep-free + testable. */
export interface S3LockClient {
  putObject(key: string, body: Uint8Array, opts: { retainUntil: Date; mode: 'COMPLIANCE' }): Promise<void>;
  getObject(key: string): Promise<Uint8Array | undefined>;
}

export class S3ObjectLockAnchor implements AuditAnchor {
  readonly id: string;
  readonly guarantee = 'external-immutable' as const;

  constructor(
    private readonly s3: S3LockClient,
    private readonly bucket: string,
    private readonly retentionDays = 3650,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.id = `s3:${bucket}`;
  }

  private key(epochId: string): string {
    return `audit/roots/${epochId}.json`;
  }

  async anchor(epoch: { epochId: string; root: Uint8Array; signature?: Signature }): Promise<AnchorReceipt> {
    const at = this.now();
    const locator = `s3://${this.bucket}/${this.key(epoch.epochId)}`;
    const receipt: AnchorReceipt = {
      anchorId: this.id,
      epochId: epoch.epochId,
      guarantee: this.guarantee,
      at,
      locator,
    };
    const body = new TextEncoder().encode(
      JSON.stringify({
        epochId: epoch.epochId,
        rootHex: Buffer.from(epoch.root).toString('hex'),
        signature: epoch.signature
          ? {
              alg: epoch.signature.alg,
              bytesHex: Buffer.from(epoch.signature.bytes).toString('hex'),
              keyRef: epoch.signature.keyRef,
            }
          : undefined,
        receipt,
      }),
    );
    await this.s3.putObject(this.key(epoch.epochId), body, {
      retainUntil: new Date(at + this.retentionDays * 86_400_000),
      mode: 'COMPLIANCE',
    });
    return receipt;
  }

  async fetch(range: { epochId?: string }): Promise<AnchoredRoot[]> {
    if (!range.epochId) return [];
    const raw = await this.s3.getObject(this.key(range.epochId));
    if (!raw) return [];
    const o = JSON.parse(new TextDecoder().decode(raw));
    const sig: Signature | undefined = o.signature
      ? {
          alg: o.signature.alg,
          bytes: Uint8Array.from(Buffer.from(o.signature.bytesHex, 'hex')),
          keyRef: o.signature.keyRef,
        }
      : undefined;
    return [
      {
        epochId: o.epochId,
        root: Uint8Array.from(Buffer.from(o.rootHex, 'hex')),
        signature: sig,
        receipt: o.receipt,
      },
    ];
  }
}
