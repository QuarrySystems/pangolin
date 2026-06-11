import { describe, it, expect } from 'vitest';
import { buildRunView } from '../../src/view/build.js';
import { renderRunView } from '../../src/view/render.js';
import { nextFrame } from '../../src/view/frame.js';
import type { RunView, StatusLike } from '../../src/view/build.js';
import type { WorkItem, Run } from '../../src/contracts/index.js';
import type { RuntimeUsage } from '@quarry-systems/pangolin-core';
import { pipeline } from '../../src/patterns/pipeline.js';
import { mapReduce } from '../../src/patterns/map-reduce.js';

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

/** Build the standard pipeline plan: a -> gate b (spawn-fix, subject 'a') -> c */
const pipelinePlan = (): Run => mkRun([
  wi('a'),
  wi('b', [], { inputs: gateInputs('a') }),
  wi('c'),
]);

// ---------------------------------------------------------------------------
// nextFrame dedup
// ---------------------------------------------------------------------------

describe('nextFrame', () => {
  it('returns null when next is identical to prev', () => {
    const lines = ['line 1', 'line 2', 'line 3'];
    expect(nextFrame(lines, ['line 1', 'line 2', 'line 3'])).toBeNull();
  });

  it('returns next when prev is undefined', () => {
    const next = ['line 1', 'line 2'];
    expect(nextFrame(undefined, next)).toBe(next);
  });

  it('returns next when content differs', () => {
    const next = ['line 1', 'CHANGED'];
    expect(nextFrame(['line 1', 'line 2'], next)).toBe(next);
  });

  it('returns next when length differs', () => {
    const next = ['line 1', 'line 2', 'line 3'];
    expect(nextFrame(['line 1', 'line 2'], next)).toBe(next);
  });

  it('returns next when shorter than prev', () => {
    const next = ['line 1'];
    expect(nextFrame(['line 1', 'line 2'], next)).toBe(next);
  });
});

// ---------------------------------------------------------------------------
// color convention (matches test/audit/render.test.ts:102-125)
// ---------------------------------------------------------------------------

describe('color convention', () => {
  it('no-color: contains no ANSI escape codes', () => {
    const view = buildRunView({ plan: pipelinePlan(), pattern: pipeline });
    const lines = renderRunView(view, { color: false, unicode: true });
    const joined = lines.join('\n');
    expect(joined).not.toMatch(/\x1b\[/);
  });

  it('color: true emits ANSI escape codes', () => {
    // Use a status so there are colored glyphs
    const status = [st('a', 'done'), st('b', 'done'), st('c', 'done')];
    const view = buildRunView({ plan: pipelinePlan(), pattern: pipeline, status });
    const lines = renderRunView(view, { color: true, unicode: true });
    expect(lines.join('\n')).toMatch(/\x1b\[/);
  });
});

// ---------------------------------------------------------------------------
// glyph set (unicode mode)
// ---------------------------------------------------------------------------

describe('glyph set — no banned glyphs', () => {
  const allStatuses: Array<{ status: string; extra?: Partial<StatusLike> }> = [
    { status: 'pending' },
    { status: 'running' },
    { status: 'done' },
    { status: 'done', extra: { verify: { passed: false } } },
    { status: 'failed' },
    { status: 'skipped' },
  ];

  it('never uses ⛩/✔/✖ (width/emoji hazards)', () => {
    const plan = mkRun(allStatuses.map((s, i) => wi(`n${i}`)));
    const status = allStatuses.map((s, i) => st(`n${i}`, s.status, s.extra));
    const view = buildRunView({ plan, status });
    const joined = renderRunView(view, { color: false, unicode: true }).join('\n');
    expect(joined).not.toContain('⛩');
    expect(joined).not.toContain('✔');
    expect(joined).not.toContain('✖');
  });

  it('uses · for pending nodes', () => {
    const plan = mkRun([wi('a')]);
    const status = [st('a', 'pending')];
    const view = buildRunView({ plan, status });
    const joined = renderRunView(view, { color: false, unicode: true }).join('\n');
    expect(joined).toContain('·');
  });

  it('uses ⟳ for running nodes', () => {
    const plan = mkRun([wi('a')]);
    const status = [st('a', 'running')];
    const view = buildRunView({ plan, status });
    const joined = renderRunView(view, { color: false, unicode: true }).join('\n');
    expect(joined).toContain('⟳');
  });

  it('uses ✓ for done nodes', () => {
    const plan = mkRun([wi('a')]);
    const status = [st('a', 'done')];
    const view = buildRunView({ plan, status });
    const joined = renderRunView(view, { color: false, unicode: true }).join('\n');
    expect(joined).toContain('✓');
  });

  it('uses ✗ for failed nodes', () => {
    const plan = mkRun([wi('a')]);
    const status = [st('a', 'failed')];
    const view = buildRunView({ plan, status });
    const joined = renderRunView(view, { color: false, unicode: true }).join('\n');
    expect(joined).toContain('✗');
  });

  it('uses ✗ for done-but-red (verifyPassed === false)', () => {
    const plan = mkRun([wi('a')]);
    const status = [st('a', 'done', { verify: { passed: false } })];
    const view = buildRunView({ plan, status });
    const joined = renderRunView(view, { color: false, unicode: true }).join('\n');
    expect(joined).toContain('✗');
  });

  it('uses ⊘ for skipped nodes', () => {
    const plan = mkRun([wi('a')]);
    const status = [st('a', 'skipped')];
    const view = buildRunView({ plan, status });
    const joined = renderRunView(view, { color: false, unicode: true }).join('\n');
    expect(joined).toContain('⊘');
  });

  it('uses ┊ for ghost nodes', () => {
    // pipeline plan pre-run — has ghosts
    const view = buildRunView({ plan: pipelinePlan(), pattern: pipeline });
    const joined = renderRunView(view, { color: false, unicode: true }).join('\n');
    expect(joined).toContain('┊');
  });

  it('uses ▣ for gate nodes', () => {
    const view = buildRunView({ plan: pipelinePlan(), pattern: pipeline });
    const joined = renderRunView(view, { color: false, unicode: true }).join('\n');
    expect(joined).toContain('▣');
  });
});

// ---------------------------------------------------------------------------
// ASCII mode
// ---------------------------------------------------------------------------

describe('ASCII mode (unicode: false)', () => {
  it('uses ASCII markers instead of unicode glyphs', () => {
    const plan = mkRun([wi('a'), wi('b', ['a'])]);
    const status = [st('a', 'done'), st('b', 'running')];
    const view = buildRunView({ plan, status });
    const joined = renderRunView(view, { color: false, unicode: false }).join('\n');
    // Should have [ok] for done
    expect(joined).toContain('[ok]');
    // Should have [>] for running
    expect(joined).toContain('[>]');
    // Should NOT contain unicode glyphs
    expect(joined).not.toContain('✓');
    expect(joined).not.toContain('⟳');
  });

  it('uses [.] for pending, [-] for skipped, [x] for failed, [:] for ghost in ASCII mode', () => {
    // ghost requires pre-run view with gate
    const view = buildRunView({ plan: pipelinePlan(), pattern: pipeline });
    const joined = renderRunView(view, { color: false, unicode: false }).join('\n');
    expect(joined).toContain('[.]');  // pending/ready pre-run real nodes
    expect(joined).toContain('[:]');  // ghost
    expect(joined).toContain('[gate]');  // gate marker
  });

  it('uses [x] for failed in ASCII mode', () => {
    const plan = mkRun([wi('a')]);
    const status = [st('a', 'failed')];
    const view = buildRunView({ plan, status });
    const joined = renderRunView(view, { color: false, unicode: false }).join('\n');
    expect(joined).toContain('[x]');
  });

  it('uses [-] for skipped in ASCII mode', () => {
    const plan = mkRun([wi('a')]);
    const status = [st('a', 'skipped')];
    const view = buildRunView({ plan, status });
    const joined = renderRunView(view, { color: false, unicode: false }).join('\n');
    expect(joined).toContain('[-]');
  });
});

// ---------------------------------------------------------------------------
// Golden: pipeline pre-run chain with a dotted ghost arc (no color, unicode)
// ---------------------------------------------------------------------------

it('renders the pipeline pre-run chain with a dotted ghost arc (no color, unicode)', () => {
  const view = buildRunView({ plan: pipelinePlan(), pattern: pipeline });
  const lines = renderRunView(view, { color: false, unicode: true });
  // Freeze the golden — produced by the implementation and locked here.
  // pipelinePlan: a -> b(gate, spawn-fix, subject 'a') -> c.
  // Ghost arc under b: b-fix-1, b~2 (gate copy, isGate=true → ▣ prefix), c~2 (c depends on b → marked).
  expect(lines).toEqual([
    '· a',
    '▣ · b',
    '  ┊ b-fix-1',
    '  ▣ ┊ b~2',
    '  ┊ c~2',
    '· c',
    '',
    'state: pre-run',
  ]);
});

// ---------------------------------------------------------------------------
// Red materialization mid-run
// ---------------------------------------------------------------------------

it('renders red materialization mid-run (gate failed, fix running)', () => {
  const status = [
    st('a', 'done'),
    st('b', 'done', { verify: { passed: false } }),
    st('c', 'skipped'),
    st('b-fix-1', 'running', { depends_on: ['a'] }),
  ];
  const view = buildRunView({ plan: pipelinePlan(), pattern: pipeline, status });
  const lines = renderRunView(view, { color: false, unicode: true });
  const joined = lines.join('\n');
  // gate is red (✗)
  expect(joined).toMatch(/▣.*✗.*b/);
  // fix is running (⟳)
  expect(joined).toContain('⟳ b-fix-1');
  // still-ghost lineage members stay ┊
  expect(joined).toContain('┊');
  // no ANSI
  expect(joined).not.toMatch(/\x1b\[/);
});

// ---------------------------------------------------------------------------
// Green collapse
// ---------------------------------------------------------------------------

it('renders green collapse (gate resolved green, ghosts dropped)', () => {
  const status = [
    st('a', 'done'),
    st('b', 'done', { verify: { passed: true } }),
    st('c', 'done'),
  ];
  const view = buildRunView({ plan: pipelinePlan(), pattern: pipeline, status });
  const lines = renderRunView(view, { color: false, unicode: true });
  const joined = lines.join('\n');
  // All real nodes are ✓ done
  expect(joined).toContain('✓ a');
  expect(joined).toContain('✓ c');
  // No ghost glyphs — ghosts dropped
  expect(joined).not.toContain('┊');
  // Gate itself renders with ✓
  expect(joined).toContain('✓');
});

// ---------------------------------------------------------------------------
// Bounded-red termination
// ---------------------------------------------------------------------------

it('renders bounded-red termination (b~2 red, c~2 skipped, terminal)', () => {
  const status = [
    st('a', 'done'),
    st('b', 'done', { verify: { passed: false } }),
    st('c', 'skipped'),
    st('b-fix-1', 'done', { depends_on: ['a'] }),
    st('b~2', 'done', { verify: { passed: false }, depends_on: ['b-fix-1'] }),
    st('c~2', 'skipped', { depends_on: ['b~2'] }),
  ];
  const view = buildRunView({ plan: pipelinePlan(), pattern: pipeline, status });
  const lines = renderRunView(view, { color: false, unicode: true });
  const joined = lines.join('\n');
  // Both gate and gate copy are red
  expect(joined).toMatch(/✗.*b[^~]/);
  expect(joined).toMatch(/✗.*b~2/);
  // c~2 is skipped
  expect(joined).toContain('⊘ c~2');
  // Footer shows terminal
  expect(joined).toContain('terminal');
  // No ghosts remain
  expect(joined).not.toContain('┊');
});

// ---------------------------------------------------------------------------
// Map-reduce fan mid-run + pre-run placeholder + collapse
// ---------------------------------------------------------------------------

describe('map-reduce fan layout', () => {
  it('renders × ? pre-run placeholder when no map items spawned yet', () => {
    const plan = mkRun([wi('split'), wi('reduce', ['split'])]);
    const view = buildRunView({ plan, pattern: mapReduce });
    const lines = renderRunView(view, { color: false, unicode: true });
    const joined = lines.join('\n');
    // Pre-run fan unexpanded → × ? placeholder
    expect(joined).toContain('× ?');
  });

  it('renders fan items mid-run', () => {
    const plan = mkRun([wi('split'), wi('reduce', ['split'])]);
    const status = [
      st('split', 'done'),
      st('map-1', 'running', { depends_on: ['split'] }),
      st('map-2', 'pending', { depends_on: ['split'] }),
      st('reduce', 'pending'),
    ];
    const view = buildRunView({ plan, pattern: mapReduce, status });
    const lines = renderRunView(view, { color: false, unicode: true });
    const joined = lines.join('\n');
    expect(joined).toContain('⟳ map-1');
    expect(joined).toContain('· map-2');
  });

  it('collapses fan to × N when exceeds width budget', () => {
    // Create more map items than the width budget
    const mapItems = Array.from({ length: 10 }, (_, i) => `map-${i}`);
    const plan = mkRun([wi('split'), wi('reduce', ['split'])]);
    const status = [
      st('split', 'done'),
      ...mapItems.map((id) => st(id, 'done', { depends_on: ['split'] })),
      st('reduce', 'running'),
    ];
    const view = buildRunView({ plan, pattern: mapReduce, status });
    // width: 20 forces collapse
    const lines = renderRunView(view, { color: false, unicode: true, width: 20 });
    const joined = lines.join('\n');
    expect(joined).toMatch(/× \d+/);
  });
});

// ---------------------------------------------------------------------------
// Tree layout with ↩ diamond re-reference
// ---------------------------------------------------------------------------

it('renders tree layout with ↩ for diamond re-references', () => {
  // a -> b, a -> c, [b,c] -> d (diamond: d depends on both b and c which both depend on a)
  const plan = mkRun([
    wi('a'),
    wi('b', ['a']),
    wi('c', ['a']),
    wi('d', ['b', 'c']),
  ]);
  const view = buildRunView({ plan });
  const lines = renderRunView(view, { color: false, unicode: true });
  const joined = lines.join('\n');
  // Should contain the node ids
  expect(joined).toContain('a');
  expect(joined).toContain('b');
  expect(joined).toContain('c');
  expect(joined).toContain('d');
  // Diamond re-reference should appear
  expect(joined).toContain('↩ see');
});

// ---------------------------------------------------------------------------
// Exempt consumer un-ghosted
// ---------------------------------------------------------------------------

it('renders data-edge-exempt consumer without ghost (not marked in ghost lineage)', () => {
  // d is data-edge-exempt (needs output from b via select.kind='output', not a control dep).
  // No pattern here — matches the anchorPlan setup in build.test.ts which confirms d~2 absent.
  // d.depends_on=[] (no control dep); after normalizeRun, d.depends_on=['b'] from needs.
  // isExempt(d, 'b') = true → d is NOT marked → no d~2 ghost.
  const plan = mkRun([
    wi('a'),
    wi('b', ['a'], { inputs: gateInputs('a') }),
    wi('c', ['b']),
    wi('d', [], { needs: { x: { from: 'b', select: { kind: 'output', path: 'x' } } } }),
  ]);
  // No pattern — avoids pipeline adding c->d chain dep which would cascade the mark
  const view = buildRunView({ plan });
  const lines = renderRunView(view, { color: false, unicode: true });
  const joined = lines.join('\n');
  // d should appear without ghost glyph (it's a real node, pre-run = no status glyph)
  expect(joined).toContain('d');
  // d~2 should NOT appear (exempt from ghost lineage)
  expect(joined).not.toContain('d~2');
  // ghost lineage should exist (c~2 etc.) but NOT d~2
  expect(joined).toContain('┊');
});

// ---------------------------------------------------------------------------
// Evidence suffix
// ---------------------------------------------------------------------------

describe('evidence suffix', () => {
  it('shows evidence suffix when usage is present: — model · $cost · turns', () => {
    const plan = mkRun([wi('a')]);
    const status = [st('a', 'done')];
    const evidence = new Map<string, RuntimeUsage>([
      ['a', { models: ['claude-3-5-sonnet'], costUsd: 0.042, turns: 7 }],
    ]);
    const view = buildRunView({ plan, status, evidence });
    const joined = renderRunView(view, { color: false, unicode: true }).join('\n');
    expect(joined).toContain('claude-3-5-sonnet');
    expect(joined).toContain('0.042');
    expect(joined).toContain('7t');
    expect(joined).toContain('—');
  });

  it('omits evidence suffix when usage is absent', () => {
    const plan = mkRun([wi('a')]);
    const status = [st('a', 'done')];
    const view = buildRunView({ plan, status });
    const joined = renderRunView(view, { color: false, unicode: true }).join('\n');
    // no evidence suffix separator
    expect(joined).not.toContain(' — ');
  });

  it('joins multiple models with comma', () => {
    const plan = mkRun([wi('a')]);
    const status = [st('a', 'done')];
    const evidence = new Map<string, RuntimeUsage>([
      ['a', { models: ['model-a', 'model-b'], costUsd: 0.01, turns: 3 }],
    ]);
    const view = buildRunView({ plan, status, evidence });
    const joined = renderRunView(view, { color: false, unicode: true }).join('\n');
    expect(joined).toContain('model-a,model-b');
  });

  it('omits absent scalars in evidence suffix', () => {
    const plan = mkRun([wi('a')]);
    const status = [st('a', 'done')];
    // no turns field
    const evidence = new Map<string, RuntimeUsage>([
      ['a', { models: ['m1'], costUsd: 0.05 }],
    ]);
    const view = buildRunView({ plan, status, evidence });
    const joined = renderRunView(view, { color: false, unicode: true }).join('\n');
    expect(joined).toContain('m1');
    expect(joined).toContain('0.05');
    // no turns suffix
    expect(joined).not.toMatch(/\d+t/);
  });
});

// ---------------------------------------------------------------------------
// Footer line
// ---------------------------------------------------------------------------

describe('footer line', () => {
  it('includes footer state (pre-run)', () => {
    const view = buildRunView({ plan: pipelinePlan(), pattern: pipeline });
    const joined = renderRunView(view, { color: false, unicode: true }).join('\n');
    expect(joined).toContain('pre-run');
  });

  it('includes footer state (running)', () => {
    const status = [st('a', 'running'), st('b', 'pending'), st('c', 'pending')];
    const view = buildRunView({ plan: pipelinePlan(), pattern: pipeline, status });
    const joined = renderRunView(view, { color: false, unicode: true }).join('\n');
    expect(joined).toContain('running');
  });

  it('includes footer state (terminal)', () => {
    const status = [st('a', 'done'), st('b', 'done'), st('c', 'done')];
    const view = buildRunView({ plan: pipelinePlan(), pattern: pipeline, status });
    const joined = renderRunView(view, { color: false, unicode: true }).join('\n');
    expect(joined).toContain('terminal');
  });

  it('includes running cost when non-zero', () => {
    const plan = mkRun([wi('a')]);
    const status = [st('a', 'done')];
    const evidence = new Map<string, RuntimeUsage>([
      ['a', { models: ['m1'], costUsd: 1.23 }],
    ]);
    const view = buildRunView({ plan, status, evidence });
    const joined = renderRunView(view, { color: false, unicode: true }).join('\n');
    expect(joined).toContain('1.23');
  });
});

// ---------------------------------------------------------------------------
// renderTree cycle guard (defense for exported surface — buildRunView output is acyclic)
// ---------------------------------------------------------------------------

describe('renderTree cycle guard', () => {
  it('renders a 2-node cycle as "↩ cycle <id>" instead of throwing RangeError', () => {
    // Manually construct a malformed RunView with A→B→A cycle (bypasses buildRunView which is acyclic)
    const cycleView: RunView = {
      layout: 'tree',
      nodes: [
        { id: 'node-a', kind: 'real', depends_on: ['node-b'] },
        { id: 'node-b', kind: 'real', depends_on: ['node-a'] },
      ],
      footer: { counts: {}, costUsd: 0, state: 'pre-run' },
    };
    let lines: string[];
    expect(() => {
      lines = renderRunView(cycleView, { color: false, unicode: true });
    }).not.toThrow();
    const joined = lines!.join('\n');
    expect(joined).toContain('↩ cycle');
  });
});

// ---------------------------------------------------------------------------
// returns string[] (not string)
// ---------------------------------------------------------------------------

it('returns an array of strings (deliberate — callers need line count for cursor-up)', () => {
  const view = buildRunView({ plan: pipelinePlan(), pattern: pipeline });
  const result = renderRunView(view, { color: false, unicode: true });
  expect(Array.isArray(result)).toBe(true);
  expect(result.every((l) => typeof l === 'string')).toBe(true);
});
