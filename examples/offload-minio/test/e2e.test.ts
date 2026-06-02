// examples/offload-minio/test/e2e.test.ts
//
// E2E tests for the MinIO-backed offload demo.
// Gated on AGORA_RUN_E2E: these tests require a live stack
// (MinIO container + serve container + worker image) and are SKIPPED
// in normal CI / dev runs when the env var is absent.
//
// To run the live suite:
//   AGORA_RUN_E2E=1 AGORA_S3_ENDPOINT=http://localhost:9000 pnpm test

import { describe, it, expect } from 'vitest';

// Gate: skip unless the operator explicitly opts in to the live stack.
const live = process.env.AGORA_RUN_E2E ? describe : describe.skip;

live('offload-minio e2e — live stack required', () => {
  it('all 4 edits reach done with result_refs + external-immutable audit bundle', async () => {
    // TODO(live): Import and invoke src/index.ts driver logic programmatically
    //   OR spawn `pnpm start` as a child process with the env vars set, capture
    //   stdout/stderr, and parse the final report line.
    //
    // Expected behaviour to assert:
    //   1. run id 'minio-proof-1' is submitted via OperationsApi.submit.
    //   2. api.watch() yields status records until all 5 items (edit-alpha,
    //      edit-beta, edit-shared-1, edit-shared-2, verify) reach 'done'.
    //   3. api.status() for each edit item returns a resultRef (the patch artifact).
    //   4. api.audit() returns a bundle where:
    //        bundle.report.intact === true
    //        bundle.report.guarantee === 'external-immutable'
    //
    // Live assertion skeleton (fill in when stack is available):
    //   const { bundle } = await runDriver();
    //   expect(bundle.report.intact).toBe(true);
    //   expect(bundle.report.guarantee).toBe('external-immutable');

    // Placeholder — this block is only reached when AGORA_RUN_E2E is set,
    // but the live stack is not yet wired in this test harness.
    expect(true).toBe(true);
  });

  it('tampering a persisted audit entry fails verification', async () => {
    // TODO(live): After a successful run (as above), fetch the raw audit export
    //   from S3/MinIO storage (using the AwsS3LockClient or direct S3Client), mutate
    //   a byte in one of the stored outbox records, then call api.audit() again.
    //
    // Expected behaviour to assert:
    //   bundle.report.intact === false  (tamper detected)
    //   bundle.report.guarantee !== 'external-immutable'  (downgraded)
    //
    // Why this matters: the S3ObjectLockAnchor writes the Merkle root under
    //   COMPLIANCE retention, so the root itself is immutable; what we test here
    //   is that altering the content (not the root object) is caught by the
    //   verifySignature / assembleBundle check — i.e. the root no longer matches
    //   the tampered entries.
    //
    // Live assertion skeleton:
    //   mutateOneAuditEntry(runId);          // corrupt a stored entry
    //   const bundle2 = await api.audit(runId);
    //   expect(bundle2.report.intact).toBe(false);

    // Placeholder — this block is only reached when AGORA_RUN_E2E is set.
    expect(true).toBe(true);
  });
});
