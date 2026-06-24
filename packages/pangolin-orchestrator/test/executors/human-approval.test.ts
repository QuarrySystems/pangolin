import { it, expect } from 'vitest';
import {
  HumanApprovalExecutor,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalSource,
} from '../../src/executors/human-approval.js';
import type { WorkItem } from '../../src/contracts/index.js';

// In-memory approval source: a human (out of band) populates `decisions`; poll returns
// null until then. `opened` records the pending requests fire() registered.
function makeSource() {
  const decisions = new Map<string, ApprovalDecision>();
  const opened: ApprovalRequest[] = [];
  const source: ApprovalSource & { decisions: typeof decisions; opened: typeof opened } = {
    decisions,
    opened,
    open(req) {
      opened.push(req);
    },
    poll(id) {
      return decisions.get(id) ?? null;
    },
  };
  return source;
}

// In-memory content-addressed blob sink (mirrors the examples' blobs map).
function makeSink() {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    put(ref: string, bytes: Uint8Array) {
      blobs.set(ref, bytes);
    },
  };
}

const reviewerItem: WorkItem = {
  id: 'draft::rev-2',
  executor: 'human-approval',
  inputs: { approverRole: 'compliance-officer' },
  depends_on: ['draft'],
  resourceLocks: [],
  needs: { work: { from: 'draft', select: { kind: 'patch' } } },
};

it('has the default executor id "human-approval"', () => {
  const exec = new HumanApprovalExecutor({ source: makeSource(), sink: makeSink() });
  expect(exec.id).toBe('human-approval');
});

it('fire opens a pending request (role + subject derived) and reconcile stays null until a decision', async () => {
  const source = makeSource();
  const exec = new HumanApprovalExecutor({ source, sink: makeSink(), namespace: 'ns' });

  const { dispatchHash } = await exec.fire(reviewerItem, { runId: 'r1', actor: 'human:submitter' });

  expect(source.opened).toHaveLength(1);
  expect(source.opened[0]!.approverRole).toBe('compliance-officer');
  expect(source.opened[0]!.subjectItemId).toBe('draft'); // derived from needs.work.from
  expect(source.opened[0]!.runId).toBe('r1');

  expect(await exec.reconcile(dispatchHash)).toBeNull(); // no human decision yet
});

it('an approve decision resolves done with verify.passed and the approver identity sealed', async () => {
  const source = makeSource();
  const sink = makeSink();
  const exec = new HumanApprovalExecutor({ source, sink, namespace: 'ns' });

  const { dispatchHash } = await exec.fire(reviewerItem, { runId: 'r1', actor: 'human:submitter' });
  source.decisions.set(dispatchHash, {
    approver: 'human:alice',
    decision: 'approve',
    decidedAt: '2026-06-24T10:00:00.000Z',
  });

  const res = await exec.reconcile(dispatchHash);
  expect(res!.status).toBe('done');
  expect(res!.verify!.passed).toBe(true);

  const ref = res!.outputRefs!['approval'];
  expect(ref).toBeDefined();
  const sealed = JSON.parse(new TextDecoder().decode(sink.blobs.get(ref!)!));
  expect(sealed.approver).toBe('human:alice');
  expect(sealed.decision).toBe('approve');
  expect(sealed.decidedAt).toBe('2026-06-24T10:00:00.000Z');
  expect(sealed.subjectItemId).toBe('draft');
  expect(sealed.approverRole).toBe('compliance-officer');
});

it('a reject decision resolves done-but-not-approved (quorum reads it as a non-approval)', async () => {
  const source = makeSource();
  const sink = makeSink();
  const exec = new HumanApprovalExecutor({ source, sink, namespace: 'ns' });

  const { dispatchHash } = await exec.fire(reviewerItem, { runId: 'r1', actor: 'human:submitter' });
  source.decisions.set(dispatchHash, {
    approver: 'human:bob',
    decision: 'reject',
    decidedAt: '2026-06-24T11:00:00.000Z',
    reason: 'insufficient evidence',
  });

  const res = await exec.reconcile(dispatchHash);
  expect(res!.status).toBe('done'); // the approval step completed; the verdict was "reject"
  expect(res!.verify!.passed).toBe(false);
  const sealed = JSON.parse(
    new TextDecoder().decode(sink.blobs.get(res!.outputRefs!['approval']!)!),
  );
  expect(sealed.decision).toBe('reject');
  expect(sealed.reason).toBe('insufficient evidence');
});

it('the sealed approval ref is content-addressed (deterministic for identical decisions)', async () => {
  const seal = async () => {
    const source = makeSource();
    const exec = new HumanApprovalExecutor({ source, sink: makeSink(), namespace: 'ns' });
    const { dispatchHash } = await exec.fire(reviewerItem, { runId: 'r1', actor: 'a' });
    source.decisions.set(dispatchHash, {
      approver: 'human:alice',
      decision: 'approve',
      decidedAt: '2026-06-24T10:00:00.000Z',
    });
    return (await exec.reconcile(dispatchHash))!.outputRefs!['approval'];
  };
  expect(await seal()).toBe(await seal());
});

it('reconcile returns null for an unknown dispatchHash', async () => {
  const exec = new HumanApprovalExecutor({ source: makeSource(), sink: makeSink() });
  expect(await exec.reconcile('not-a-real-hash')).toBeNull();
});

it('fire seals the engine-resolved inputRefs so the approval binds to the exact artifact', async () => {
  const sink = makeSink();
  const exec = new HumanApprovalExecutor({ source: makeSource(), sink, namespace: 'ns' });
  // The engine resolves needs.work → the subject's product and sets inputs.inputRefs before fire.
  const item: WorkItem = {
    ...reviewerItem,
    inputs: {
      approverRole: 'compliance-officer',
      inputRefs: { work: 'pangolin://draft-artifact' },
    },
  };
  const { manifestRef } = await exec.fire(item, { runId: 'r1', actor: 'human:submitter' });
  expect(manifestRef).toBeDefined();
  const manifest = JSON.parse(new TextDecoder().decode(sink.blobs.get(manifestRef!)!));
  expect(manifest.inputRefs).toEqual({ work: 'pangolin://draft-artifact' });
});
