import { it, expect, describe } from 'vitest';
import { buildRunView } from '../../src/view/build.js';
import type { RunView, RunViewNode, StatusLike } from '../../src/view/build.js';
import type { StatusItem } from '../../src/index.js';
import type { Run, WorkItem, Pattern } from '../../src/contracts/index.js';
import type { RuntimeUsage } from '@quarry-systems/agora-core';
import { pipeline } from '../../src/patterns/pipeline.js';
import { mapReduce } from '../../src/patterns/map-reduce.js';
import { staticDag } from '../../src/patterns/static-dag.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const wi = (id: string, depends_on: string[] = [], extra: Partial<WorkItem> = {}): WorkItem => ({
  id, executor: 'x', inputs: {}, depends_on, resourceLocks: [], ...extra,
});

const mkRun = (items: WorkItem[], id = 'r1'): Run => ({ id, queue: 'q', items });

const gateInputs = (subject: string): Record<string, unknown> => ({
  gate: { onRed: 'spawn-fix', subject, fixTemplate: { executor: 'x', inputs: {} } },
});

const st = (id: string, status: string, extra: Partial<StatusLike> = {}): StatusLike => ({
  id, status, ...extra,
});

const node = (view: RunView, id: string): RunViewNode => {
  const n = view.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`node ${id} not found in [${view.nodes.map((x) => x.id).join(', ')}]`);
  return n;
};

const has = (view: RunView, id: string): boolean => view.nodes.some((x) => x.id === id);

/** The anchor plan: a -> gate b (spawn-fix, subject 'a') -> c (control dep), d (data-edge needs). */
const anchorPlan = (): Run => mkRun([
  wi('a'),
  wi('b', ['a'], { inputs: gateInputs('a') }),
  wi('c', ['b']),
  wi('d', [], { needs: { x: { from: 'b', select: { kind: 'output', path: 'x' } } } }),
]);

// ---------------------------------------------------------------------------
// compile-time pin: StatusLike must remain a structural subset of StatusItem
// ---------------------------------------------------------------------------

it('StatusLike is assignable from StatusItem (compile-time pin)', () => {
  // Direct cast (no `unknown` laundering) — the assignment itself IS the check:
  // if StatusItem ever stops being a structural superset of StatusLike, this fails typecheck.
  const _pin: StatusLike[] = [] as StatusItem[];
  expect(Array.isArray(_pin)).toBe(true);
});

// ---------------------------------------------------------------------------
// ghost synthesis (the anchor case — assertions binding per task spec)
// ---------------------------------------------------------------------------

describe('ghost synthesis', () => {
  it('synthesizes one ghost generation under a spawn-fix gate, pruning data-edge-exempt consumers', () => {
    // plan: a -> gate(b, spawn-fix, subject 'a') -> c(control dep on b), d(needs {from:'b', select:{kind:'output',path:'x'}})
    const view = buildRunView({ plan: anchorPlan() });

    // expect ghosts: b-fix-1, b~2, c~2 — and NO d~2 (exempt)
    expect(node(view, 'b-fix-1').kind).toBe('ghost');
    expect(node(view, 'b~2').kind).toBe('ghost');
    expect(node(view, 'c~2').kind).toBe('ghost');
    expect(has(view, 'd~2')).toBe(false);

    // ghost c~2 depends_on [b~2]
    expect(node(view, 'c~2').depends_on).toEqual(['b~2']);
    // ghost b~2 depends_on [b-fix-1]  <- subject->fix substitution exception
    expect(node(view, 'b~2').depends_on).toEqual(['b-fix-1']);
    // ghost b-fix-1 depends_on [a]    (the subject)
    expect(node(view, 'b-fix-1').depends_on).toEqual(['a']);
  });

  it('marks multi-parent dependents when ANY parent is marked; exempt-exclusive descendants stay unghosted', () => {
    const plan = mkRun([
      ...anchorPlan().items,
      wi('e', ['c', 'd']),   // parents: c (marked) + d (exempt) -> marked
      wi('f', ['d']),        // exclusive descendant of exempt d -> NOT marked
    ]);
    const view = buildRunView({ plan });
    expect(node(view, 'e~2').kind).toBe('ghost');
    expect(node(view, 'e~2').depends_on).toEqual(['c~2', 'd']); // lineage edge remapped, non-lineage kept
    expect(has(view, 'f~2')).toBe(false);
  });

  it('synthesizes no ghosts when no item declares a spawn-fix gate', () => {
    const view = buildRunView({ plan: mkRun([wi('a'), wi('b', ['a'])]) });
    expect(view.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(view.nodes.every((n) => n.kind === 'real')).toBe(true);
  });

  it('orders nodes plan-first then ghost generations, and flags gates', () => {
    const view = buildRunView({ plan: anchorPlan() });
    expect(view.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd', 'b-fix-1', 'b~2', 'c~2']);
    expect(node(view, 'b').isGate).toBe(true);
    expect(node(view, 'b~2').isGate).toBe(true);
    expect(node(view, 'a').isGate).toBe(false);
    expect(node(view, 'b-fix-1').isGate).toBe(false);
    // generations via parseAttempt: attempt - 1
    expect(node(view, 'a').generation).toBe(0);
    expect(node(view, 'b-fix-1').generation).toBe(0);
    expect(node(view, 'b~2').generation).toBe(1);
    expect(node(view, 'c~2').generation).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// pattern application: plan() THEN normalizeRun, throw propagation, layouts
// ---------------------------------------------------------------------------

describe('pattern application and layout selection', () => {
  it('applies pipeline.plan() then normalizeRun (chain edges + needs auto-union, in that order)', () => {
    const plan = mkRun([
      wi('a'),
      wi('b'),
      wi('c', [], { needs: { in: { from: 'a', select: { kind: 'output', path: 'r' } } } }),
    ]);
    const view = buildRunView({ plan, pattern: pipeline });
    expect(view.layout).toBe('chain');
    expect(node(view, 'b').depends_on).toEqual(['a']);
    // plan() ran FIRST (c was empty -> chained to b), THEN normalizeRun unioned 'a'.
    expect(node(view, 'c').depends_on).toEqual(['b', 'a']);
  });

  it('propagates a throwing pattern.plan() to the caller', () => {
    const boom: Pattern = {
      id: 'pipeline',
      plan: () => { throw new Error('malformed pattern config'); },
      onTaskDone: () => null,
    };
    expect(() => buildRunView({ plan: mkRun([wi('a')]), pattern: boom }))
      .toThrow('malformed pattern config');
  });

  it('selects fan layout for map-reduce', () => {
    const view = buildRunView({ plan: mkRun([wi('split')]), pattern: mapReduce });
    expect(view.layout).toBe('fan');
  });

  it('falls back to tree layout with no pattern', () => {
    const view = buildRunView({ plan: mkRun([wi('a')]) });
    expect(view.layout).toBe('tree');
  });

  it('uses tree layout for static-dag', () => {
    const view = buildRunView({ plan: mkRun([wi('a')]), pattern: staticDag });
    expect(view.layout).toBe('tree');
  });
});

// ---------------------------------------------------------------------------
// status reconciliation
// ---------------------------------------------------------------------------

describe('status reconciliation', () => {
  it('keeps ghosts dotted while the gate is unresolved', () => {
    const status = [st('a', 'done'), st('b', 'running'), st('c', 'pending'), st('d', 'pending')];
    const view = buildRunView({ plan: anchorPlan(), status });
    expect(node(view, 'b-fix-1').kind).toBe('ghost');
    expect(node(view, 'b~2').kind).toBe('ghost');
    expect(node(view, 'c~2').kind).toBe('ghost');
  });

  it('reconciles a ghost into a real node when its counterpart appears in status', () => {
    const status = [
      st('a', 'done'),
      st('b', 'done', { verify: { passed: false } }),
      st('c', 'skipped'),
      st('d', 'running'),
      st('b-fix-1', 'running', { depends_on: ['a'] }),
    ];
    const view = buildRunView({ plan: anchorPlan(), status });
    const fix = node(view, 'b-fix-1');
    expect(fix.kind).toBe('real');
    expect(fix.status).toBe('running');
    expect(fix.depends_on).toEqual(['a']); // placed via status depends_on
    // unspawned lineage members stay ghosts (gate is red, not green-resolved)
    expect(node(view, 'b~2').kind).toBe('ghost');
    expect(node(view, 'c~2').kind).toBe('ghost');
  });

  it('drops remaining ghosts when the gate resolves green (done + verify.passed !== false)', () => {
    const greenView = buildRunView({
      plan: anchorPlan(),
      status: [st('a', 'done'), st('b', 'done', { verify: { passed: true } }), st('c', 'running'), st('d', 'running')],
    });
    expect(has(greenView, 'b-fix-1')).toBe(false);
    expect(has(greenView, 'b~2')).toBe(false);
    expect(has(greenView, 'c~2')).toBe(false);

    // done with NO verify also counts as green
    const noVerifyView = buildRunView({
      plan: anchorPlan(),
      status: [st('a', 'done'), st('b', 'done'), st('c', 'running'), st('d', 'running')],
    });
    expect(has(noVerifyView, 'b~2')).toBe(false);
  });

  it('bounded red: a red gate~2 produces NO ghost generation 3 and the run reads terminal', () => {
    const status = [
      st('a', 'done'),
      st('b', 'done', { verify: { passed: false } }),
      st('c', 'skipped'),
      st('d', 'done'),
      st('b-fix-1', 'done', { depends_on: ['a'] }),
      st('b~2', 'done', { verify: { passed: false }, depends_on: ['b-fix-1'] }),
      st('c~2', 'skipped', { depends_on: ['b~2'] }),
    ];
    const view = buildRunView({ plan: anchorPlan(), status });
    expect(view.nodes.every((n) => n.kind === 'real')).toBe(true);
    expect(has(view, 'b-fix-2')).toBe(false);
    expect(has(view, 'b~3')).toBe(false);
    expect(has(view, 'c~3')).toBe(false);
    expect(node(view, 'b~2').verifyPassed).toBe(false);
    expect(view.footer.state).toBe('terminal');
  });

  it('places spawned items (no ghost counterpart) via their status depends_on', () => {
    const status = [
      st('split', 'done'),
      st('map-x', 'running', { depends_on: ['split'] }),
      st('map-y', 'pending', { depends_on: ['split'] }),
    ];
    const view = buildRunView({ plan: mkRun([wi('split')]), pattern: mapReduce, status });
    const mx = node(view, 'map-x');
    expect(mx.kind).toBe('real');
    expect(mx.status).toBe('running');
    expect(mx.depends_on).toEqual(['split']);
    expect(node(view, 'map-y').depends_on).toEqual(['split']);
    // plan node first, spawned after
    expect(view.nodes.map((n) => n.id)).toEqual(['split', 'map-x', 'map-y']);
  });
});

// ---------------------------------------------------------------------------
// evidence + footer
// ---------------------------------------------------------------------------

describe('evidence and footer', () => {
  it('attaches evidence usage to nodes and sums costUsd in the footer', () => {
    const evidence = new Map<string, RuntimeUsage>([
      ['a', { models: ['m1'], costUsd: 0.5, turns: 3 }],
      ['b', { models: ['m2'], costUsd: 0.25 }],
    ]);
    const status = [st('a', 'done'), st('b', 'done'), st('c', 'running'), st('d', 'running')];
    const view = buildRunView({ plan: anchorPlan(), status, evidence });
    expect(node(view, 'a').usage).toEqual({ models: ['m1'], costUsd: 0.5, turns: 3 });
    expect(node(view, 'b').usage).toEqual({ models: ['m2'], costUsd: 0.25 });
    expect(node(view, 'c').usage).toBeUndefined();
    expect(view.footer.costUsd).toBeCloseTo(0.75);
  });

  it('reports pre-run state when no status is given (no statuses, ghosts dotted)', () => {
    const view = buildRunView({ plan: anchorPlan() });
    expect(view.footer.state).toBe('pre-run');
    expect(view.footer.counts).toEqual({});
    expect(view.footer.costUsd).toBe(0);
    expect(node(view, 'a').status).toBeUndefined();
    expect(node(view, 'a').verifyPassed).toBeUndefined();
  });

  it('counts items by status and reports running until every item is terminal', () => {
    const running = buildRunView({
      plan: anchorPlan(),
      status: [st('a', 'done'), st('b', 'running'), st('c', 'pending'), st('d', 'pending')],
    });
    expect(running.footer.state).toBe('running');
    expect(running.footer.counts).toEqual({ done: 1, running: 1, pending: 2 });

    const terminal = buildRunView({
      plan: anchorPlan(),
      status: [st('a', 'done'), st('b', 'failed'), st('c', 'skipped'), st('d', 'cancelled')],
    });
    expect(terminal.footer.state).toBe('terminal');
    expect(terminal.footer.counts).toEqual({ done: 1, failed: 1, skipped: 1, cancelled: 1 });
  });

  it('exposes verifyPassed from status verify', () => {
    const view = buildRunView({
      plan: anchorPlan(),
      status: [st('a', 'done', { verify: { passed: true } }), st('b', 'running'), st('c', 'pending'), st('d', 'pending')],
    });
    expect(node(view, 'a').verifyPassed).toBe(true);
    expect(node(view, 'b').verifyPassed).toBeUndefined();
  });

  it('carries the run id', () => {
    expect(buildRunView({ plan: anchorPlan() }).runId).toBe('r1');
  });
});

// ---------------------------------------------------------------------------
// purity / determinism
// ---------------------------------------------------------------------------

describe('purity', () => {
  it('is deterministic and does not mutate the input plan', () => {
    const plan = anchorPlan();
    const snapshot = JSON.parse(JSON.stringify(plan)) as Run;
    const v1 = buildRunView({ plan, pattern: pipeline });
    const v2 = buildRunView({ plan, pattern: pipeline });
    expect(v1).toEqual(v2);
    expect(plan).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// scripted live progression (frame-over-frame transitions)
// ---------------------------------------------------------------------------

describe('scripted status progression', () => {
  // pipeline: a -> b(gate, subject 'a') -> c ; gate goes red, lineage materializes, settles green
  const plan = mkRun([
    wi('a'),
    wi('b', [], { inputs: gateInputs('a') }),
    wi('c'),
  ]);

  const polls: StatusLike[][] = [
    // p1: run starts
    [st('a', 'running'), st('b', 'pending'), st('c', 'pending')],
    // p2: a done, gate running
    [st('a', 'done'), st('b', 'running'), st('c', 'pending')],
    // p3: gate red, c skipped — lineage not yet spawned
    [st('a', 'done'), st('b', 'done', { verify: { passed: false } }), st('c', 'skipped')],
    // p4: lineage materialized
    [
      st('a', 'done'), st('b', 'done', { verify: { passed: false } }), st('c', 'skipped'),
      st('b-fix-1', 'running', { depends_on: ['a'] }),
      st('b~2', 'pending', { depends_on: ['b-fix-1'] }),
      st('c~2', 'pending', { depends_on: ['b~2'] }),
    ],
    // p5: settled green
    [
      st('a', 'done'), st('b', 'done', { verify: { passed: false } }), st('c', 'skipped'),
      st('b-fix-1', 'done', { depends_on: ['a'] }),
      st('b~2', 'done', { verify: { passed: true }, depends_on: ['b-fix-1'] }),
      st('c~2', 'done', { depends_on: ['b~2'] }),
    ],
  ];

  it('tracks node transitions frame over frame across >=4 polls', () => {
    const frames = polls.map((status) => buildRunView({ plan, pattern: pipeline, status }));

    // the fix ghost materializes into a real node at p4
    expect(frames.map((f) => node(f, 'b-fix-1').kind)).toEqual(['ghost', 'ghost', 'ghost', 'real', 'real']);
    expect(frames.map((f) => node(f, 'b~2').kind)).toEqual(['ghost', 'ghost', 'ghost', 'real', 'real']);

    // the subject progresses then holds
    expect(frames.map((f) => node(f, 'a').status)).toEqual(['running', 'done', 'done', 'done', 'done']);

    // the gate goes red at p3 and stays sealed
    expect(frames.map((f) => node(f, 'b').verifyPassed)).toEqual([undefined, undefined, false, false, false]);

    // c is skipped from p3 on; its ghost copy runs to done
    expect(frames.map((f) => node(f, 'c').status)).toEqual(['pending', 'pending', 'skipped', 'skipped', 'skipped']);
    expect(frames[4] && node(frames[4], 'c~2').status).toBe('done');

    // run state: running -> running -> terminal(momentary, pre-spawn) -> running -> terminal
    expect(frames.map((f) => f.footer.state)).toEqual(['running', 'running', 'terminal', 'running', 'terminal']);

    // chain layout throughout
    expect(frames.every((f) => f.layout === 'chain')).toBe(true);
  });
});
