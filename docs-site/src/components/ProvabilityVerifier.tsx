import { useEffect, useState, useCallback } from 'react';
import { Zap, RotateCcw } from 'lucide-react';
import {
  sealHonest,
  deriveReport,
  reseal,
  applyTamper,
  nodeStatuses,
  type DemoState,
  type DemoItem,
  type NodeStatus,
} from '../lib/sealVerify';
import type { VerificationReport } from '@quarry-systems/pangolin-core';
import { BUNDLES, bundleById, type TamperPreset } from '../lib/demoBundle';
import { Ledger } from './Ledger';
import { Verdict, Checklist } from './Verdict';
import './verifier.css';

export default function ProvabilityVerifier() {
  const [bundleId, setBundleId] = useState(BUNDLES[0]!.id);
  const [state, setState] = useState<DemoState | null>(null);
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [statuses, setStatuses] = useState<Record<string, NodeStatus>>({});
  const [selected, setSelected] = useState('d2');
  const [tampered, setTampered] = useState(false);

  const bundle = bundleById(bundleId);

  // Seal a fresh copy whenever the domain changes; preserve the operator's
  // chosen anchor tier + time toggle across reskins so the demo flow holds.
  useEffect(() => {
    let live = true;
    (async () => {
      const sealed = await sealHonest(bundleById(bundleId).items);
      if (!live) return;
      setState((s) => ({
        sealed,
        tier: s?.tier ?? 's3-worm',
        timeAttested: s?.timeAttested ?? false,
      }));
      setTampered(false);
      setSelected('d2');
    })();
    return () => {
      live = false;
    };
  }, [bundleId]);

  useEffect(() => {
    if (!state) return;
    let live = true;
    (async () => {
      const [r, st] = await Promise.all([deriveReport(state), nodeStatuses(state)]);
      if (live) {
        setReport(r);
        setStatuses(st);
      }
    })();
    return () => {
      live = false;
    };
  }, [state]);

  const setItems = useCallback((next: DemoItem[]) => {
    setState((s) => (s ? { ...s, sealed: { ...s.sealed, items: next } } : s));
    setTampered(true);
  }, []);

  const onPreset = (t: TamperPreset) => {
    if (!state) return;
    setItems(applyTamper(state.sealed.items, t.target, t.field, t.value));
    setSelected(t.target);
  };
  const onEdit = (id: string, field: 'outputPayload' | 'scope', value: string) => {
    if (!state) return;
    setItems(applyTamper(state.sealed.items, id, field, value));
  };
  const onReseal = async () => {
    if (state) setState(await reseal(state));
  };
  const onRestore = async () => {
    setState({
      sealed: await sealHonest(bundle.items),
      tier: state?.tier ?? 's3-worm',
      timeAttested: state?.timeAttested ?? false,
    });
    setTampered(false);
  };
  const setTier = (tier: DemoState['tier']) => setState((s) => (s ? { ...s, tier } : s));
  const toggleTime = () => setState((s) => (s ? { ...s, timeAttested: !s.timeAttested } : s));

  if (!state || !report) return <div className="pv-root">Loading…</div>;
  const resealCaption =
    tampered && report.intact && state.tier === 'local'
      ? {
          cls: 'is-bad',
          text: 'The root lives in the same store the attacker controls — rewrite the log, rewrite the root. The local tier proves consistency, not immutability. That is why it only ever claims tamper-detecting.',
        }
      : tampered && report.failure === 'root-mismatch' && state.tier === 's3-worm'
        ? {
            cls: 'is-ok',
            text: 'The anchored root is in a separate trust domain (WORM). The attacker rewrote the bundle — but not the anchor. That is tamper-evident.',
          }
        : null;

  return (
    <div className="pv-root">
      <header className="pv-header">
        <div className="pv-brand">
          <div>
            <div className="pv-eyebrow">Audit bundle verifier</div>
            <div className="pv-wordmark">Pangolin</div>
            <div className="pv-subtitle">{bundle.subtitle}</div>
          </div>
        </div>
      </header>

      <section className="pv-controls pv-domain-row">
        <span className="pv-ctl-label">Domain</span>
        <div className="pv-ctl-btns">
          <div className="pv-tier pv-domains">
            {BUNDLES.map((b) => (
              <button
                key={b.id}
                className={b.id === bundleId ? 'is-on' : ''}
                onClick={() => setBundleId(b.id)}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <Verdict report={report} />
      <Checklist report={report} />

      <section className="pv-controls">
        <span className="pv-ctl-label">
          <Zap size={13} /> Try to break the seal
        </span>
        <div className="pv-ctl-btns">
          {bundle.tampers.map((t) => (
            <button key={t.id} className="pv-tamper" onClick={() => onPreset(t)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="pv-ctl-btns pv-ctl-actions">
          {tampered && (
            <button className="pv-reseal" onClick={onReseal}>
              Re-seal the bundle (act as the attacker)
            </button>
          )}
          <button className="pv-restore" onClick={onRestore}>
            <RotateCcw size={13} /> Restore bundle
          </button>
        </div>
      </section>

      <section className="pv-controls">
        <span className="pv-ctl-label">Anchor</span>
        <div className="pv-ctl-btns">
          <div className="pv-tier">
            <button
              className={state.tier === 'local' ? 'is-on' : ''}
              onClick={() => setTier('local')}
            >
              LocalAnchor · detect
            </button>
            <button
              className={state.tier === 's3-worm' ? 'is-on' : ''}
              onClick={() => setTier('s3-worm')}
            >
              S3 Object Lock · external-immutable
            </button>
          </div>
          <label className="pv-ctl-label pv-ctl-check">
            <input type="checkbox" checked={state.timeAttested} onChange={toggleTime} /> Attach
            RFC-3161 timestamp
          </label>
        </div>
      </section>

      {resealCaption && <p className={'pv-caption ' + resealCaption.cls}>{resealCaption.text}</p>}

      <p className="pv-flowhint">
        <b>The sealed plan.</b> Each card is one dispatch; a line links a step to the step it
        depends on, and the flow widens where work runs in parallel. Select a card to edit its
        payload — tamper one and watch the break ripple downstream.
      </p>

      <Ledger
        items={state.sealed.items}
        statuses={statuses}
        selected={selected}
        onSelect={setSelected}
        onEdit={onEdit}
      />

      <footer className="pv-footer">
        Real SHA-256, computed in your browser. The anchor is simulated; the verdict is the
        production <code>VerificationReport</code> shape and <code>claimFor</code> rule.
      </footer>
    </div>
  );
}
