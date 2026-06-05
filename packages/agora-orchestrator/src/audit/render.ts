import type { AuditBundle, CheckResult, AuditEntryRow } from '../contracts/index.js';

export interface RenderOpts {
  /** Pass true to wrap the verdict and check markers in ANSI color. Default: plain text. */
  color?: boolean;
  /** Pass true to show every ledger row without head+tail truncation. */
  full?: boolean;
}

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

const ANSI = { green: '\x1b[32m', red: '\x1b[31m', dim: '\x1b[2m', reset: '\x1b[0m' } as const;

/** Wrap `s` in an ANSI code when color is on; otherwise return it unchanged. */
function paint(s: string, code: string, color: boolean): string {
  return color ? `${code}${s}${ANSI.reset}` : s;
}

// ---------------------------------------------------------------------------
// Marker helpers
// ---------------------------------------------------------------------------

function mark(c: CheckResult, color: boolean): string {
  if (c.ok === true) return paint('✓', ANSI.green, color);
  if (c.ok === 'n/a') return paint('─', ANSI.dim, color);
  return paint('✗', ANSI.red, color);
}

function truncHash(h: string, len = 6): string {
  return h.slice(0, len);
}

/** Extract the failing entry seq from a chain check's detail string ("entry 7 hash ..."). */
function failingSeqOf(chain: CheckResult): number | undefined {
  if (chain.ok !== false || !chain.detail) return undefined;
  const m = chain.detail.match(/entry (\d+)/);
  return m ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const HEAD = 3;
const TAIL = 3;

function ledgerRow(e: AuditEntryRow, failing: number | undefined, color: boolean): string {
  const isFailing = failing !== undefined && e.seq === failing;
  const flag = isFailing ? paint(' ✗', ANSI.red, color) : '';
  return `  ${String(e.seq).padStart(4)}  ${truncHash(e.entryHash).padEnd(6)}  ${e.kind}${flag}`;
}

function buildLedger(
  entries: AuditEntryRow[],
  failingSeq: number | undefined,
  full: boolean,
  color: boolean,
): string[] {
  if (entries.length === 0) return ['  (no entries)'];

  if (full || entries.length <= HEAD + TAIL) {
    return entries.map((e) => ledgerRow(e, failingSeq, color));
  }

  const head = entries.slice(0, HEAD).map((e) => ledgerRow(e, failingSeq, color));
  const tail = entries.slice(-TAIL).map((e) => ledgerRow(e, failingSeq, color));
  const omitted = entries.length - HEAD - TAIL;
  return [...head, `  …(${omitted} more)`, ...tail];
}

// ---------------------------------------------------------------------------
// Main formatter
// ---------------------------------------------------------------------------

export function renderVerification(bundle: AuditBundle, opts: RenderOpts = {}): string {
  const r = bundle.report;
  const color = opts.color === true; // only add ANSI when explicitly requested; false/undefined → plain
  const full = opts.full === true;

  const verdictLabel = r.intact
    ? paint(`✓ ${r.claim.toUpperCase()}`, ANSI.green, color)
    : paint('✗ TAMPERED', ANSI.red, color);
  const sep = '─'.repeat(58);
  const failingSeq = failingSeqOf(r.checks.chain);

  const lines: string[] = [];

  // Header
  lines.push(`  agora verify  ·  ${bundle.runId}                  ${verdictLabel}`);
  lines.push('  ' + sep);

  // Check rows
  const chainDetail =
    r.checks.chain.detail ?? `${bundle.auditLog.entries.length} entries, hash-linked, no gaps`;
  lines.push(`  ${mark(r.checks.chain, color)} chain        ${chainDetail}`);

  const rootDetail =
    r.checks.root.detail ?? (r.checks.root.ok === 'n/a' ? 'n/a' : 'merkle = anchored root');
  lines.push(`  ${mark(r.checks.root, color)} root         ${rootDetail}`);

  const sigDetail =
    r.checks.signature.detail ??
    (r.checks.signature.ok === 'n/a' ? 'n/a' : String(r.checks.signature.ok));
  lines.push(`  ${mark(r.checks.signature, color)} signature    ${sigDetail}`);

  lines.push(`  ${mark(r.checks.anchor, color)} anchor       ${r.anchorId}  (${r.guarantee})`);

  lines.push('  ' + sep);

  // Ledger
  lines.push(`  ${'seq'.padStart(4)}  ${'hash'.padEnd(6)}  kind`);
  lines.push(...buildLedger(bundle.auditLog.entries, failingSeq, full, color));

  lines.push('  ' + sep);

  // Footer
  const entries = bundle.auditLog.entries;
  const firstAt = entries[0]?.at ?? '—';
  const lastAt = entries[entries.length - 1]?.at ?? '—';
  const reconciled = bundle.items.length;
  const total = bundle.auditLog.entries.length;
  lines.push(
    `  ${reconciled}/${total} items reconciled  ·  anchor: ${r.anchorId}  ·  ran ${firstAt}→${lastAt} (unattended)`,
  );

  return lines.join('\n');
}
