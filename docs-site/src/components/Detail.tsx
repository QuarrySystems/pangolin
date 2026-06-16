import type { ReactNode } from 'react';
import { KeyRound, AlertTriangle, FileCheck } from 'lucide-react';
import type { DemoItem, NodeStatus } from '../lib/sealVerify';

function Field({ label, value, hint, icon, editable, onChange }: {
  label: string; value: string; hint?: string; icon?: ReactNode;
  editable?: boolean; onChange?: (v: string) => void;
}) {
  return (
    <label className={'pv-field' + (editable ? ' is-editable' : '')}>
      <span className="pv-fieldlabel">{icon}{label}{editable && <span className="pv-editbadge">editable</span>}</span>
      {editable ? (
        <input className="mono pv-input" value={value} onChange={(e) => onChange?.(e.target.value)} spellCheck={false} />
      ) : (
        <span className="mono pv-fieldval">{value}</span>
      )}
      {hint && <span className="pv-fieldhint">{hint}</span>}
    </label>
  );
}

export function Detail({ item, status, onEdit }: {
  item: DemoItem; status: NodeStatus;
  onEdit: (id: string, field: 'outputPayload' | 'scope', value: string) => void;
}) {
  return (
    <section className={'pv-detail is-' + status}>
      <div className="pv-detail-head">
        <div>
          <span className="pv-tag">{item.id} · {item.action}</span>
          <h3>{item.label}</h3>
        </div>
      </div>
      <div className="pv-fields">
        <Field label="Input payload" value={item.inputPayload} hint={`executor ${item.executor}`} />
        <Field label="Output payload" value={item.outputPayload} hint="decoded resultRef — the bundle seals the ref"
          editable onChange={(v) => onEdit(item.id, 'outputPayload', v)} />
        <Field label="Credential scope" value={item.scope} icon={<KeyRound size={12} />}
          editable onChange={(v) => onEdit(item.id, 'scope', v)} />
        <Field label="secretRef" value={item.secretRef} icon={<KeyRound size={12} />}
          hint="reference — the secret value never enters the bundle" />
      </div>
      <div className="pv-hashes">
        {status === 'broken' && (
          <p className="pv-note is-broken"><AlertTriangle size={13} /> This step's own fields are intact, but it depends on a tampered step — so its proof no longer holds.</p>
        )}
        {status === 'tampered' && (
          <p className="pv-note is-tampered"><AlertTriangle size={13} /> A sealed field changed after the bundle was sealed. Everything downstream is now unprovable.</p>
        )}
        {status === 'verified' && (
          <p className="pv-note is-ok"><FileCheck size={13} /> This step's recomputed hash matches the seal.</p>
        )}
      </div>
    </section>
  );
}
