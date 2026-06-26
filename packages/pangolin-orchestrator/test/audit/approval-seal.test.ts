// Unit + parity tests for the engine-free `sealApproval` pure function.
// The parity test is the no-behaviour-change guarantee: the ref/bytes produced
// by sealApproval must equal byte-for-byte what HumanApprovalExecutor.reconcile()
// seals, since the executor now calls sealApproval internally.
import { describe, it, expect } from 'vitest';
import { canonicalJsonString, computeContentHash } from '@quarry-systems/pangolin-core';
import { sealApproval, type ApprovalRecord } from '../../src/audit/approval.js';
import { HumanApprovalExecutor, type ApprovalSource } from '../../src/executors/human-approval.js';
import type { FireContext, WorkItem } from '../../src/contracts/index.js';

const RECORD: ApprovalRecord = {
  approvalId: 'appr-r1-rev-2',
  runId: 'r1',
  subjectItemId: 'rev-2',
  approverRole: 'compliance-officer',
  approver: 'human:alice',
  decision: 'approve',
  decidedAt: '2026-06-24T10:00:00.000Z',
};

describe('sealApproval', () => {
  it('seals a record to content-addressed ref + canonical bytes, deterministically', () => {
    const a = sealApproval(RECORD, { namespace: 'ns' });
    const b = sealApproval(RECORD, { namespace: 'ns' });
    expect(a.ref).toBe(b.ref);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    // bytes are the canonical JSON of the record
    expect(new TextDecoder().decode(a.bytes)).toBe(canonicalJsonString(RECORD));
    // ref = pangolin://<ns>/approval/a/<sha256 of the bytes>
    expect(a.ref).toBe(`pangolin://ns/approval/a/${computeContentHash(a.bytes)}`);
    expect(a.ref).toMatch(/^pangolin:\/\/ns\/approval\/a\/sha256:[0-9a-f]{64}$/);
  });

  it('defaults the namespace to "ns"', () => {
    expect(sealApproval(RECORD).ref).toBe(sealApproval(RECORD, { namespace: 'ns' }).ref);
  });

  it('namespace changes only the ref prefix, never the content hash', () => {
    const a = sealApproval(RECORD, { namespace: 'ns' });
    const b = sealApproval(RECORD, { namespace: 'changeorder' });
    expect(a.ref.split('/').pop()).toBe(b.ref.split('/').pop()); // same record → same hash
    expect(b.ref.startsWith('pangolin://changeorder/approval/a/')).toBe(true);
  });

  it('matches HumanApprovalExecutor.reconcile() byte-for-byte (DRY parity)', async () => {
    const blobs = new Map<string, Uint8Array>();
    const source: ApprovalSource = {
      poll: () => ({
        approver: 'human:alice',
        decision: 'approve',
        decidedAt: '2026-06-24T10:00:00.000Z',
      }),
    };
    const exec = new HumanApprovalExecutor({
      source,
      sink: { put: (ref, bytes) => void blobs.set(ref, bytes) },
      namespace: 'ns',
    });
    const item = {
      id: 'rev-2',
      executor: 'human-approval',
      inputs: { approverRole: 'compliance-officer' },
      depends_on: [],
      resourceLocks: [],
    } as unknown as WorkItem;
    const { dispatchHash } = await exec.fire(item, { runId: 'r1' } as FireContext);
    const res = await exec.reconcile(dispatchHash);
    const sealedRef = res!.outputRefs!.approval!;
    const sealedBytes = blobs.get(sealedRef)!;

    // The executor builds this exact record (subjectItemId falls back to item.id; approvalId = dispatchHash).
    const sealed = sealApproval(
      {
        approvalId: dispatchHash,
        runId: 'r1',
        subjectItemId: 'rev-2',
        approverRole: 'compliance-officer',
        approver: 'human:alice',
        decision: 'approve',
        decidedAt: '2026-06-24T10:00:00.000Z',
      },
      { namespace: 'ns' },
    );
    expect(sealed.ref).toBe(sealedRef);
    expect(Buffer.from(sealed.bytes).equals(Buffer.from(sealedBytes))).toBe(true);
  });
});
