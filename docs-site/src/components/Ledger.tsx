import { useRef, useState, useLayoutEffect, useCallback } from 'react';
import { KeyRound, AlertTriangle, FileCheck } from 'lucide-react';
import { topoOrder, type DemoItem, type NodeStatus } from '../lib/sealVerify';

function StatusDot({ status }: { status: NodeStatus }) {
  const map: Record<NodeStatus, string> = { verified: 'Sealed', tampered: 'Tampered', broken: 'Broken' };
  return <span className={'pv-dot is-' + status}>{map[status]}</span>;
}

interface Conn { from: string; to: string; x1: number; y1: number; x2: number; y2: number; }

/** A vertical, top-to-bottom audit ledger: one dispatch per row, a left rail drawing the
 *  fork/merge edges, payloads stacked inline, output + scope editable on the selected row.
 *  Tampering a row's own fields ripples the break downward along the chain. */
export function Ledger({ items, statuses, selected, onSelect, onEdit }: {
  items: DemoItem[];
  statuses: Record<string, NodeStatus>;
  selected: string;
  onSelect: (id: string) => void;
  onEdit: (id: string, field: 'outputPayload' | 'scope', value: string) => void;
}) {
  const order = topoOrder(items);
  const idx: Record<string, number> = Object.fromEntries(order.map((id, i) => [id, i]));
  const byId = new Map(items.map((i) => [i.id, i]));
  const wrapRef = useRef<HTMLDivElement>(null);
  const dotRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const [conns, setConns] = useState<Conn[]>([]);

  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const wb = wrap.getBoundingClientRect();
    const lines: Conn[] = [];
    for (const it of items) {
      const child = dotRefs.current[it.id];
      if (!child) continue;
      const cb = child.getBoundingClientRect();
      for (const p of it.parents) {
        const par = dotRefs.current[p];
        if (!par) continue;
        const pb = par.getBoundingClientRect();
        lines.push({
          from: p, to: it.id,
          x1: pb.left - wb.left + pb.width / 2, y1: pb.top - wb.top + pb.height / 2,
          x2: cb.left - wb.left + cb.width / 2, y2: cb.top - wb.top + cb.height / 2,
        });
      }
    }
    setConns(lines);
  }, [items]);

  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (wrapRef.current) ro.observe(wrapRef.current);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [measure]);

  const connState = (c: Conn) => {
    const s = statuses[c.from];
    return s === 'tampered' || s === 'broken' ? 'broken' : 'ok';
  };

  return (
    <div className="pv-ledger" ref={wrapRef}>
      <svg className="pv-rail-edges" aria-hidden="true">
        {conns.map((c, i) => {
          // Adjacent parent→child: a straight vertical segment on the spine. Skip-edges (the
          // two diagonal legs of the diamond) bow left into a side lane to clear the dot(s)
          // they pass — a commit-graph-style rail.
          const gap = Math.abs((idx[c.to] ?? 0) - (idx[c.from] ?? 0));
          const d =
            gap <= 1
              ? `M ${c.x1} ${c.y1} L ${c.x2} ${c.y2}`
              : (() => {
                  const lane = Math.min(c.x1, c.x2) - (12 + (gap - 2) * 8);
                  return `M ${c.x1} ${c.y1} C ${lane} ${c.y1 + 10}, ${lane} ${c.y2 - 10}, ${c.x2} ${c.y2}`;
                })();
          return <path key={i} className={'pv-rail-edge is-' + connState(c)} d={d} />;
        })}
      </svg>

      {order.map((id) => {
        const it = byId.get(id)!;
        const st = statuses[id] ?? 'verified';
        const isSel = selected === id;
        return (
          <div key={id} className={`pv-row is-${st}` + (isSel ? ' is-selected' : '')}>
            <div className="pv-rail">
              <span ref={(el) => { dotRefs.current[id] = el; }} className={'pv-rail-dot is-' + st} />
            </div>
            <div className="pv-step" role="button" tabIndex={0} onClick={() => onSelect(id)}>
              <div className="pv-step-head">
                <span className="pv-step-action mono">{it.action}</span>
                <span className="pv-step-label">{it.label}</span>
                <span className="pv-step-scope mono">{it.scope}</span>
                <StatusDot status={st} />
              </div>

              <div className="pv-payloads">
                <div className="pv-pl">
                  <span className="pv-pl-k mono">in</span>
                  <span className="pv-pl-v mono">{it.inputPayload}</span>
                </div>
                <div className="pv-pl">
                  <span className="pv-pl-k mono">out</span>
                  {isSel ? (
                    <input className="pv-pl-input mono" value={it.outputPayload} spellCheck={false}
                      aria-label={`${it.id} output payload`}
                      onChange={(e) => onEdit(id, 'outputPayload', e.target.value)} />
                  ) : (
                    <span className="pv-pl-v mono">{it.outputPayload}</span>
                  )}
                </div>
                {isSel && (
                  <div className="pv-pl">
                    <span className="pv-pl-k mono"><KeyRound size={11} /> scope</span>
                    <input className="pv-pl-input mono" value={it.scope} spellCheck={false}
                      aria-label={`${it.id} credential scope`}
                      onChange={(e) => onEdit(id, 'scope', e.target.value)} />
                  </div>
                )}
              </div>

              {isSel && (
                <div className="pv-row-foot">
                  <span className="pv-secretref mono">secretRef {it.secretRef} — reference only, never sealed</span>
                  {st === 'broken' && (
                    <span className="pv-rownote is-broken"><AlertTriangle size={12} /> depends on a tampered step — its proof no longer holds</span>
                  )}
                  {st === 'tampered' && (
                    <span className="pv-rownote is-tampered"><AlertTriangle size={12} /> a sealed field changed — everything downstream is now unprovable</span>
                  )}
                  {st === 'verified' && (
                    <span className="pv-rownote is-ok"><FileCheck size={12} /> recomputed hash matches the seal</span>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
