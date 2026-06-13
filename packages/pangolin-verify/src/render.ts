// Readable terminal summary of a verification report. A local renderer (the orchestrator's
// renderVerification is not available to this standalone package) that mirrors its layout
// closely enough to feel familiar. Used by the CLI when --json is not passed.

import type { AuditBundle, CheckResult, AuditEntryRow } from '@quarry-systems/pangolin-core';

export interface RenderOpts {
  /** Wrap the verdict and check markers in ANSI color. Default: plain text. */
  color?: boolean;
  /** Show every ledger row without head+tail truncation. */
  full?: boolean;
}

const ANSI = { green: '\x1b[32m', red: '\x1b[31m', dim: '\x1b[2m', reset: '\x1b[0m' } as const;

function paint(s: string, code: string, color: boolean): string {
  return color ? `${code}${s}${ANSI.reset}` : s;
}

function mark(c: CheckResult, color: boolean): string {
  if (c.ok === true) return paint('✓', ANSI.green, color);
  if (c.ok === 'n/a') return paint('─', ANSI.dim, color);
  return paint('✗', ANSI.red, color);
}

function truncHash(h: string, len = 6): string {
  return h.slice(0, len);
}

function failingSeqOf(chain: CheckResult): number | undefined {
  if (chain.ok !== false || !chain.detail) return undefined;
  const m = chain.detail.match(/entry (\d+)/);
  return m ? Number(m[1]) : undefined;
}

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

export function renderVerification(bundle: AuditBundle, opts: RenderOpts = {}): string {
  const r = bundle.report;
  const color = opts.color === true;
  const full = opts.full === true;

  const verdictLabel = r.intact
    ? paint(`✓ ${r.claim.toUpperCase()}`, ANSI.green, color)
    : paint('✗ TAMPERED', ANSI.red, color);
  const sep = '─'.repeat(58);
  const failingSeq = failingSeqOf(r.checks.chain);

  const lines: string[] = [];
  lines.push(`  pangolin-verify  ·  ${bundle.runId}                  ${verdictLabel}`);
  lines.push('  ' + sep);

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

  const handoff = r.checks.handoff ?? { ok: 'n/a' as const };
  const handoffDetail = handoff.detail ?? (handoff.ok === 'n/a' ? 'n/a' : String(handoff.ok));
  lines.push(`  ${mark(handoff, color)} handoff      ${handoffDetail}`);

  // Trusted time is a SEPARATE dimension from the tamper claim — show the tier.
  const time = r.checks.time ?? { ok: 'n/a' as const };
  const timeDetail = time.detail ?? `time tier: ${r.timeTier}`;
  lines.push(`  ${mark(time, color)} time         ${timeDetail}`);

  lines.push('  ' + sep);
  lines.push(`  ${'seq'.padStart(4)}  ${'hash'.padEnd(6)}  kind`);
  lines.push(...buildLedger(bundle.auditLog.entries, failingSeq, full, color));
  lines.push('  ' + sep);

  const entries = bundle.auditLog.entries;
  const firstAt = entries[0]?.at ?? '—';
  const lastAt = entries[entries.length - 1]?.at ?? '—';
  lines.push(
    `  ${bundle.items.length}/${entries.length} items reconciled  ·  anchor: ${r.anchorId}  ·  ran ${firstAt}→${lastAt}`,
  );

  return lines.join('\n');
}
