import { ShieldCheck, ShieldAlert } from 'lucide-react';
import type { VerificationReport } from '@quarry-systems/pangolin-core';

const CHECK_ROWS: { key: keyof VerificationReport['checks']; label: string }[] = [
  { key: 'chain', label: 'chain' },
  { key: 'root', label: 'root' },
  { key: 'signature', label: 'signature' },
  { key: 'anchor', label: 'anchor' },
  { key: 'time', label: 'time' }, // handoff omitted — n/a for a single-run demo
];

/** The verdict banner + the two orthogonal axis badges (tamper + time). */
export function Verdict({ report }: { report: VerificationReport | null }) {
  if (!report) return <div className="pv-verdict is-wait">Verifying…</div>;
  const evident = report.claim === 'tamper-evident';
  const tampered = !report.intact;
  return (
    <div className="pv-verdict-wrap">
      <div className={'pv-verdict ' + (tampered ? 'is-bad' : 'is-ok')}>
        {tampered ? <ShieldAlert size={18} /> : <ShieldCheck size={18} />}
        <div>
          <div className="pv-verdict-head">{tampered ? 'Tamper detected' : 'Verified'}</div>
          <div className="pv-verdict-sub">
            {report.failure ? `first failing check: ${report.failure}` : 'seal intact, chain consistent'}
          </div>
        </div>
      </div>
      <div className="pv-axis">
        <span className={'pv-axis-badge' + (evident ? ' is-evident' : '')}>
          tamper: {tampered ? 'FAILED' : report.claim}
        </span>
        <span className={'pv-axis-badge' + (report.timeTier === 'tsa-attested' ? ' is-attested' : '')}>
          time: {report.timeTier}
        </span>
        <span className="pv-axis-badge">{report.anchorId} · {report.guarantee}</span>
      </div>
    </div>
  );
}

/** A compact, full-width CLI-style strip of the per-check results. */
export function Checklist({ report }: { report: VerificationReport | null }) {
  if (!report) return null;
  return (
    <div className="pv-checklist" role="status" aria-label="verification checks">
      {CHECK_ROWS.map(({ key, label }) => {
        const ok = report.checks[key].ok;
        const cls = ok === true ? 'is-ok' : ok === false ? 'is-fail' : 'is-na';
        const mark = ok === true ? '✓' : ok === false ? '✗' : '·';
        return (
          <span key={key} className={'pv-check ' + cls}>
            <span className="mono">{mark}</span>
            <span>{label}</span>
            {report.checks[key].detail && <span className="mono pv-check-detail">{report.checks[key].detail}</span>}
          </span>
        );
      })}
    </div>
  );
}
