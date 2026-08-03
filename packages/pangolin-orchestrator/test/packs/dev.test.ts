import { it, expect } from 'vitest';
import { devPack, devCodeEdit, devVerify, devRegistry } from '../../src/packs/dev.js';
import { PackRegistry } from '../../src/packs/registry.js';
import { validateShape } from '../../src/contracts/subagent-shape.js';
import { SqliteRunStateStore } from '../../src/runstate/sqlite.js';
import { tick } from '../../src/engine/tick.js';
import type { WorkItem } from '../../src/contracts/types.js';

it('dev shapes declare correct effect tiers', () => {
  expect(devCodeEdit.effectTier).toBe('write-impure');
  expect(devVerify.effectTier).toBe('read-impure');
});

it("devCodeEdit declares outputEdgeType 'patch-ref'", () => {
  expect(devCodeEdit.outputEdgeType).toBe('patch-ref');
});

it("devVerify declares inputEdgeTypes mapping patch to 'patch-ref'", () => {
  expect(devVerify.inputEdgeTypes).toEqual({ patch: 'patch-ref' });
});

it('dev shapes register without collision and schema round-trips are correct', () => {
  const r = new PackRegistry(devPack);

  // dev.code-edit — valid case
  expect(
    r.get('dev.code-edit')?.inputSchema.safeParse({ baseCommit: 'a', instructions: 'do x' })
      .success,
  ).toBe(true);

  // dev.code-edit — invalid: wrong type AND missing field (original case kept)
  expect(r.get('dev.code-edit')?.inputSchema.safeParse({ baseCommit: 1 }).success).toBe(false);

  // dev.code-edit — invalid: structurally complete but instructions is wrong type (isolates one constraint)
  expect(
    r.get('dev.code-edit')?.inputSchema.safeParse({ baseCommit: 'a', instructions: 42 }).success,
  ).toBe(false);

  // dev.verify — valid case
  expect(
    r
      .get('dev.verify')
      ?.inputSchema.safeParse({ patch: { baseCommit: 'a', diff: '--- a\n+++ b\n' } }).success,
  ).toBe(true);

  // dev.verify — invalid: bare string instead of object with patch
  expect(r.get('dev.verify')?.inputSchema.safeParse('not-an-object').success).toBe(false);

  // dev.verify — invalid: patch field is a string instead of a patchSchema object
  expect(r.get('dev.verify')?.inputSchema.safeParse({ patch: 'x' }).success).toBe(false);
});

/**
 * KNOWN-ISSUES 17a — these pin a SURPRISING current truth, so that anyone who
 * changes it has to change these tests deliberately.
 *
 * 17 reports that `imageDigest: "sha256:PLACEHOLDER"` makes dev shapes
 * undispatchable. It does not. `imageDigest` is read by exactly one thing —
 * `validateShape`'s truthiness check — and the placeholder is truthy. Nothing at
 * dispatch time consults it: `DispatchExecutor.fire` never references
 * `subagentShape` or `capability`, and takes `workerImage` from executor config.
 *
 * If the pinned digest is ever made ENFORCED — a real governance property, since
 * a shape claims its code runs in a specific image and nothing verifies that —
 * these tests are where that intent gets recorded.
 */
it('validateShape accepts the placeholder digest — a truthiness check, not a pin', () => {
  expect(devVerify.capability.imageDigest).toBe('sha256:PLACEHOLDER');
  expect(() => validateShape(devVerify)).not.toThrow();
  expect(() => validateShape(devCodeEdit)).not.toThrow();
});

it('a dev-shaped item DISPATCHES with the placeholder digest in place', async () => {
  const store = new SqliteRunStateStore(); // defaults to :memory:
  store.ensureQueue('default', 10);
  const item: WorkItem = {
    id: 'verify-item',
    executor: 'rec',
    inputs: { patch: { baseCommit: 'a', diff: '--- a\n+++ b\n' } },
    depends_on: [],
    resourceLocks: [],
    subagentShape: 'dev.verify',
  };
  store.saveRun({ id: 'run-17a', queue: 'default', items: [item] }, 'human:test');
  store.markReady(['verify-item']);

  const fired: string[] = [];
  const exec = {
    id: 'rec',
    async fire(i: WorkItem) {
      fired.push(i.id);
      return { dispatchHash: `h-${i.id}` };
    },
    async reconcile() {
      return { status: 'done' as const };
    },
  };

  await tick(store, { rec: exec }, 'default', devRegistry());

  // The placeholder blocks nothing. This is the claim 17 gets wrong, and the
  // reason pinning a real digest would be a no-op dressed as a fix.
  expect(fired).toContain('verify-item');
  expect(store.getItems('run-17a').find((i) => i.id === 'verify-item')?.status).toBe('running');
});

it('contextShape is descriptive only — no code reads it', () => {
  // The string is the whole of the "guarantee". Nothing stages a repo snapshot or
  // applies a patch because of it, which is why dev.verify cannot yet do what its
  // contextShape describes. Asserting the literal keeps that honest: if the phrase
  // ever becomes load-bearing, this test has to change alongside it.
  expect(devVerify.capability.contextShape).toBe('repo snapshot + patch applied');
  expect(devCodeEdit.capability.contextShape).toBe('repo worktree at baseCommit');
});
