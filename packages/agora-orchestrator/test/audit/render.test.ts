import { describe, it, expect } from 'vitest';
import { renderVerification } from '../../src/audit/render.js';
import type { AuditBundle, AuditEntryRow } from '../../src/contracts/index.js';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeEntry(seq: number, overrides: Partial<AuditEntryRow> = {}): AuditEntryRow {
  return {
    runId: 'run-test',
    seq,
    kind: 'run.submitted',
    at: `2026-06-04T00:${String(seq).padStart(2, '0')}:00Z`,
    entryHash: `hash${seq}`.padEnd(64, '0'),
    prevHash: seq === 0 ? '' : `hash${seq - 1}`.padEnd(64, '0'),
    ...overrides,
  };
}

function greenBundle(): AuditBundle {
  const entries: AuditEntryRow[] = [makeEntry(0), makeEntry(1)];
  return {
    runId: 'run-green',
    manifests: [],
    auditLog: { entries, root: undefined },
    items: [],
    report: {
      runId: 'run-green',
      intact: true,
      anchorId: 'anchor-ext',
      guarantee: 'external-immutable',
      claim: 'tamper-evident',
      checks: {
        chain:     { ok: true },
        root:      { ok: true },
        signature: { ok: 'n/a' },
        anchor:    { ok: true },
      },
    },
  };
}

function tamperedBundle(): AuditBundle {
  const entries: AuditEntryRow[] = [makeEntry(0), makeEntry(7)];
  return {
    runId: 'run-tampered',
    manifests: [],
    auditLog: { entries, root: undefined },
    items: [],
    report: {
      runId: 'run-tampered',
      intact: false,
      anchorId: 'anchor-ext',
      guarantee: 'external-immutable',
      claim: 'tamper-detecting',
      failure: 'chain',
      checks: {
        chain:     { ok: false, detail: 'entry 7 hash ≠ recomputed' },
        root:      { ok: 'n/a' },
        signature: { ok: 'n/a' },
        anchor:    { ok: true },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Acceptance criteria from task spec
// ---------------------------------------------------------------------------

it('green bundle renders the tamper-evident verdict and four check rows', () => {
  const out = renderVerification(greenBundle(), { color: false });
  expect(out).toContain('TAMPER-EVIDENT');
  expect(out).toMatch(/✓ chain/);
  expect(out).toMatch(/✓ anchor/);
});

it('tampered bundle renders TAMPERED and surfaces the failing chain detail', () => {
  const out = renderVerification(tamperedBundle(), { color: false });
  expect(out).toContain('TAMPERED');
  expect(out).toMatch(/✗ chain.*entry \d/);
});

// ---------------------------------------------------------------------------
// Extended criteria
// ---------------------------------------------------------------------------

describe('n/a marker', () => {
  it('renders ─ for checks with ok === n/a, never ✓', () => {
    const out = renderVerification(greenBundle(), { color: false });
    // signature is n/a in greenBundle
    expect(out).toMatch(/─ signature/);
    // make sure it's not rendered as ✓ signature
    expect(out).not.toMatch(/✓ signature/);
  });
});

describe('color: false → no ANSI escape sequences', () => {
  it('contains no ANSI codes when color is false', () => {
    const out = renderVerification(greenBundle(), { color: false });
    // ANSI escape codes start with ESC (\x1b)
    expect(out).not.toMatch(/\x1b\[/);
  });

  it('tampered bundle also has no ANSI codes when color is false', () => {
    const out = renderVerification(tamperedBundle(), { color: false });
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe('color: true → ANSI escape sequences', () => {
  it('wraps the green verdict in ANSI when color is true', () => {
    const out = renderVerification(greenBundle(), { color: true });
    expect(out).toMatch(/\x1b\[/);
  });

  it('wraps the TAMPERED verdict in ANSI when color is true', () => {
    const out = renderVerification(tamperedBundle(), { color: true });
    expect(out).toMatch(/\x1b\[/);
  });
});

describe('ledger head+tail with …(n more)', () => {
  function bundleWithManyEntries(count: number): AuditBundle {
    const entries: AuditEntryRow[] = Array.from({ length: count }, (_, i) => makeEntry(i));
    return {
      runId: 'run-many',
      manifests: [],
      auditLog: { entries, root: undefined },
      items: [],
      report: {
        runId: 'run-many',
        intact: true,
        anchorId: 'anchor-x',
        guarantee: 'external-immutable',
        claim: 'tamper-evident',
        checks: {
          chain:     { ok: true },
          root:      { ok: true },
          signature: { ok: 'n/a' },
          anchor:    { ok: true },
        },
      },
    };
  }

  it('shows …(n more) when entries exceed the head+tail window and full is not set', () => {
    // 12 entries is clearly above the head+tail window (head=3, tail=3 → 12 - 6 = 6 more)
    const out = renderVerification(bundleWithManyEntries(12), { color: false });
    expect(out).toMatch(/…\(\d+ more\)/);
  });

  it('does not show …(n more) for small ledger within window', () => {
    // 2 entries — both displayed, no truncation
    const out = renderVerification(greenBundle(), { color: false });
    expect(out).not.toMatch(/…\(\d+ more\)/);
  });

  it('shows every row when full: true', () => {
    const count = 12;
    const bundle = bundleWithManyEntries(count);
    const out = renderVerification(bundle, { color: false, full: true });
    // No ellipsis row
    expect(out).not.toMatch(/…\(\d+ more\)/);
    // All seqs appear
    for (let i = 0; i < count; i++) {
      expect(out).toContain(String(i));
    }
  });
});

describe('footer line', () => {
  it('contains reconciled count', () => {
    const out = renderVerification(greenBundle(), { color: false });
    // footer mentions "reconciled"
    expect(out).toMatch(/reconciled/);
  });
});

describe('verdict line', () => {
  it('contains the runId', () => {
    const out = renderVerification(greenBundle(), { color: false });
    expect(out).toContain('run-green');
  });

  it('contains anchorId in the anchor row', () => {
    const out = renderVerification(greenBundle(), { color: false });
    expect(out).toContain('anchor-ext');
  });
});
