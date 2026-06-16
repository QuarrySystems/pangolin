import { ShieldCheck, ShieldAlert } from 'lucide-react';
import type { VerificationReport } from '@quarry-systems/pangolin-core';

const CHECK_ROWS: { key: keyof VerificationReport['checks']; label: string }[] = [
  { key: 'chain', label: 'chain' },
  { key: 'root', label: 'root' },
  { key: 'signature', label: 'signature' },
  { key: 'anchor', label: 'anchor' },
  { key: 'time', label: 'time' }, // handoff omitted — n/a for a single-run demo
];

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
      <div className="pv-checklist">
        {CHECK_ROWS.map(({ key, label }) => {
          const ok = report.checks[key].ok;
          const cls = ok === true ? 'is-ok' : ok === false ? 'is-fail' : 'is-na';
          const mark = ok === true ? '✓' : ok === false ? '✗' : '·';
          return (
            <div key={key} className={'pv-check ' + cls}>
              <span className="mono">{mark}</span>
              <span>{label}</span>
              {report.checks[key].detail && <span className="mono">{report.checks[key].detail}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
