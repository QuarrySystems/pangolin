import { it, expect } from 'vitest';
import { quorum } from '../../src/patterns/quorum.js';

// A valid 3-reviewer quorum config, threshold 2-of-3, circle-back on reject.
const cfg = {
  reviewers: [
    { executor: 'dispatch', inputs: {}, subagentShape: 'opus' },
    { executor: 'dispatch', inputs: {}, subagentShape: 'sonnet' },
    { executor: 'dispatch', inputs: {}, subagentShape: 'haiku' },
  ],
  threshold: 2,
  commit: { executor: 'dispatch', inputs: {} },
  onReject: 'spawn-fix',
  fixTemplate: { executor: 'dispatch', inputs: {} },
};

const subject = {
  id: 'draft',
  status: 'done',
  executor: 'dispatch',
  inputs: { quorum: cfg },
  depends_on: [],
  resourceLocks: [],
  resultRef: 'pangolin://draft',
} as never;

const reviewer = (id: string, status: string, passed?: boolean) =>
  ({
    id,
    status,
    executor: 'dispatch',
    inputs: {},
    depends_on: ['draft'],
    resourceLocks: [],
    ...(passed !== undefined ? { verify: { passed } } : {}),
  }) as never;

// --- plan() validation -------------------------------------------------------

it('plan passes a valid quorum config through unchanged (identity)', () => {
  const run = {
    id: 'r',
    queue: 'q',
    items: [
      {
        id: 'draft',
        executor: 'dispatch',
        inputs: { quorum: cfg },
        depends_on: [],
        resourceLocks: [],
      },
    ],
  };
  expect(quorum.plan(run)).toBe(run);
});

it('plan throws when threshold exceeds the reviewer count', () => {
  const bad = { ...cfg, threshold: 5 };
  const run = {
    id: 'r',
    queue: 'q',
    items: [
      {
        id: 'draft',
        executor: 'dispatch',
        inputs: { quorum: bad },
        depends_on: [],
        resourceLocks: [],
      },
    ],
  };
  expect(() => quorum.plan(run)).toThrow(/threshold/);
});

it('plan throws when onReject is spawn-fix but no fixTemplate is given', () => {
  const bad = { reviewers: cfg.reviewers, threshold: 2, commit: cfg.commit, onReject: 'spawn-fix' };
  const run = {
    id: 'r',
    queue: 'q',
    items: [
      {
        id: 'draft',
        executor: 'dispatch',
        inputs: { quorum: bad },
        depends_on: [],
        resourceLocks: [],
      },
    ],
  };
  expect(() => quorum.plan(run)).toThrow(/fixTemplate/);
});

// --- Phase 1: fan-out --------------------------------------------------------

it('a done subject fans out one independent reviewer per template', () => {
  const d = quorum.onTaskDone(subject, { runItems: [subject] });
  expect(d!.items.map((i) => i.id)).toEqual(['draft::rev-0', 'draft::rev-1', 'draft::rev-2']);
  expect(d!.items.map((i) => i.subagentShape)).toEqual(['opus', 'sonnet', 'haiku']);
  expect(d!.items[0]!.depends_on).toEqual(['draft']);
  expect(d!.items[0]!.needs!['work']).toEqual({ from: 'draft', select: { kind: 'patch' } });
});

// --- Phase 2: tally ----------------------------------------------------------

it('returns null until every reviewer is terminal', () => {
  const revs = [
    reviewer('draft::rev-0', 'done', true),
    reviewer('draft::rev-1', 'running'),
    reviewer('draft::rev-2', 'done', true),
  ];
  expect(quorum.onTaskDone(revs[0]!, { runItems: [subject, ...revs] })).toBeNull();
});

it('spawns the commit item when approvals reach the threshold', () => {
  const revs = [
    reviewer('draft::rev-0', 'done', true),
    reviewer('draft::rev-1', 'done', true),
    reviewer('draft::rev-2', 'done', false), // dissent — still 2/3 approve
  ];
  const d = quorum.onTaskDone(revs[2]!, { runItems: [subject, ...revs] });
  expect(d!.items.map((i) => i.id)).toEqual(['draft::commit']);
  expect(d!.items[0]!.depends_on).toEqual(['draft']);
  expect(d!.items[0]!.needs!['work']).toEqual({ from: 'draft', select: { kind: 'patch' } });
});

it('does not re-spawn the commit once it already exists', () => {
  const revs = [
    reviewer('draft::rev-0', 'done', true),
    reviewer('draft::rev-1', 'done', true),
    reviewer('draft::rev-2', 'done', true),
  ];
  const commit = {
    id: 'draft::commit',
    status: 'pending',
    executor: 'dispatch',
    inputs: {},
    depends_on: ['draft'],
    resourceLocks: [],
  } as never;
  expect(quorum.onTaskDone(revs[2]!, { runItems: [subject, ...revs, commit] })).toBeNull();
});

// --- Phase 2: reject / circle-back ------------------------------------------

it('on reject below threshold, spawns a fix + a re-review subject copy carrying the config forward', () => {
  const revs = [
    reviewer('draft::rev-0', 'done', true),
    reviewer('draft::rev-1', 'failed'),
    reviewer('draft::rev-2', 'done', false), // only 1/3 approve < 2
  ];
  const d = quorum.onTaskDone(revs[2]!, { runItems: [subject, ...revs] });
  expect(d!.items.map((i) => i.id)).toEqual(['draft-fix-1', 'draft~2']);
  const copy = d!.items.find((i) => i.id === 'draft~2')!;
  expect(copy.depends_on).toEqual(['draft-fix-1']);
  expect(copy.needs!['work']).toEqual({ from: 'draft-fix-1', select: { kind: 'patch' } });
  expect((copy.inputs as Record<string, unknown>)['quorum']).toBeDefined(); // re-fans out next round
});

it('does not circle back once maxRounds is exhausted', () => {
  const subject2 = { ...subject, id: 'draft~2' } as never; // attempt 2, default maxRounds 1
  const revs = [
    reviewer('draft~2::rev-0', 'done', true),
    reviewer('draft~2::rev-1', 'failed'),
    reviewer('draft~2::rev-2', 'done', false),
  ].map((r) => ({ ...(r as object), depends_on: ['draft~2'] }) as never);
  expect(quorum.onTaskDone(revs[2]!, { runItems: [subject2, ...revs] })).toBeNull();
});

it("with onReject 'block', a sub-threshold tally spawns nothing (rejection is final)", () => {
  const blockCfg = {
    reviewers: cfg.reviewers,
    threshold: 2,
    commit: cfg.commit,
    onReject: 'block',
  };
  const subjectBlock = { ...subject, inputs: { quorum: blockCfg } } as never;
  const revs = [
    reviewer('draft::rev-0', 'done', true),
    reviewer('draft::rev-1', 'failed'),
    reviewer('draft::rev-2', 'done', false),
  ];
  expect(quorum.onTaskDone(revs[2]!, { runItems: [subjectBlock, ...revs] })).toBeNull();
});

// --- contract invariants -----------------------------------------------------

it('never spawns from a cancelled cause', () => {
  expect(
    quorum.onTaskDone({ id: 'draft::rev-0', status: 'cancelled' } as never, { runItems: [] }),
  ).toBeNull();
});

it('is deterministic — identical args yield deeply-equal directives', () => {
  const ctx = { runItems: [subject] };
  expect(quorum.onTaskDone(subject, ctx)).toEqual(quorum.onTaskDone(subject, ctx));
});
