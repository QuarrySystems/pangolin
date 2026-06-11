# -systems/pangolin-storage-s3

`StorageProvider` backed by S3 with a content-addressed, integrity-verified object layout — the production storage target.

```bash
pnpm add -systems/pangolin-storage-s3
```

Part of [pangolin](https://quarrysystems.github.io/pangolin).

## Encryption

By default the provider sets **no** server-side-encryption (SSE) field on its
writes, inheriting whatever the bucket's default encryption is. Since January
2023 every S3 bucket has SSE-S3 on by default, so objects are encrypted at rest
out of the box. Leaving `encryption` unset is the **no-downgrade** default:
forcing `AES256` onto a bucket whose default is KMS would silently downgrade it,
so the provider touches nothing unless you ask it to.

Set the optional `encryption` option to enforce an explicit mode on every object
pangolin writes (content blobs, per-name `_index.json` files, and dispatch records):

```ts
import { S3StorageProvider } from '-systems/pangolin-storage-s3';

// SSE-S3 (S3-managed keys), explicitly enforced:
new S3StorageProvider({ bucket: 'my-bucket', encryption: { mode: 'AES256' } });

// SSE-KMS with a customer-managed key (BYOK):
new S3StorageProvider({
  bucket: 'my-bucket',
  encryption: { mode: 'aws:kms', kmsKeyId: 'arn:aws:kms:…:key/abc' },
});

// SSE-KMS using the bucket's default KMS key (omit kmsKeyId):
new S3StorageProvider({ bucket: 'my-bucket', encryption: { mode: 'aws:kms' } });
```

Encryption is applied to writes only — GET/HEAD/list/delete are unaffected.

License: BUSL-1.1
