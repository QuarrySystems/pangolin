import { useRef, useState, useLayoutEffect, useCallback } from 'react';
import { KeyRound, AlertTriangle, FileCheck } from 'lucide-react';
import { topoOrder, type DemoItem, type NodeStatus } from '../lib/sealVerify';

/** Group ids into dependency levels (depth = longest path from a root). Parallel steps land
 *  in the same level and render side-by-side, so a fork/merge is visible as the flow widens. */
function levelsOf(items: DemoItem[]): string[][] {
  const order = topoOrder(items);
  const byId = new Map(items.map((i) => [i.id, i]));
  const depth = new Map<string, number>();
  for (const id of order) {
    const ps = byId.get(id)!.parents;
    depth.set(id, ps.length ? Math.max(...ps.map((p) => depth.get(p)! + 1)) : 0);
  }
  const max = Math.max(0, ...depth.values());
  return Array.from({ length: max + 1 }, (_, d) => order.filter((id) => depth.get(id) === d));
}

function StatusDot({ status }: { status: NodeStatus }) {
  const map: Record<NodeStatus, string> = { verified: 'Sealed', tampered: 'Tampered', broken: 'Broken' };
  return <span className={'pv-dot is-' + status}>{map[status]}</span>;
}

interface Edge { from: string; to: string; x1: number; y1: number; x2: number; y2: number; }

/** A top-to-bottom flow of dispatches. Each level is a horizontal band (parallel steps sit
 *  side-by-side); connectors run parent-bottom → child-top so the fork/merge is explicit.
 *  Payloads stack inline; output + scope are editable on the selected card. */
export function Ledger({ items, statuses, selected, onSelect, onEdit }: {
  items: DemoItem[];
  statuses: Record<string, NodeStatus>;
  selected: string;
  onSelect: (id: string) => void;
  onEdit: (id: string, field: 'outputPayload' | 'scope', value: string) => void;
}) {
  const levels = levelsOf(items);
  const byId = new Map(items.map((i) => [i.id, i]));
  const wrapRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [edges, setEdges] = useState<Edge[]>([]);

  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const wb = wrap.getBoundingClientRect();
    const lines: Edge[] = [];
    for (const it of items) {
      const child = cardRefs.current[it.id];
      if (!child) continue;
      const cb = child.getBoundingClientRect();
      for (const p of it.parents) {
        const par = cardRefs.current[p];
        if (!par) continue;
        const pb = par.getBoundingClientRect();
        lines.push({
          from: p, to: it.id,
          x1: pb.left - wb.left + pb.width / 2, y1: pb.bottom - wb.top, // parent bottom-center
          x2: cb.left - wb.left + cb.width / 2, y2: cb.top - wb.top,    // child top-center
        });
      }
    }
    setEdges(lines);
  }, [items]);

  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (wrapRef.current) ro.observe(wrapRef.current);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [measure]);

  const edgeState = (e: Edge) => {
    const s = statuses[e.from];
    return s === 'tampered' || s === 'broken' ? 'broken' : 'ok';
  };

  return (
    <div className="pv-flow" ref={wrapRef}>
      <svg className="pv-flow-edges" aria-hidden="true">
        {edges.map((e, i) => {
          const my = (e.y1 + e.y2) / 2;
          return (
            <path key={i} className={'pv-flow-edge is-' + edgeState(e)}
              d={`M ${e.x1} ${e.y1} C ${e.x1} ${my}, ${e.x2} ${my}, ${e.x2} ${e.y2}`} />
          );
        })}
      </svg>

      {levels.map((level, li) => (
        <div className="pv-band" key={li}>
          {level.map((id) => {
            const it = byId.get(id)!;
            const st = statuses[id] ?? 'verified';
            const isSel = selected === id;
            return (
              <div key={id} ref={(el) => { cardRefs.current[id] = el; }}
                className={`pv-step is-${st}` + (isSel ? ' is-selected' : '')}
                role="button" tabIndex={0} onClick={() => onSelect(id)}>
                <div className="pv-step-head">
                  <span className="pv-step-action mono">{it.action}</span>
                  <span className="pv-step-label">{it.label}</span>
                  <StatusDot status={st} />
                </div>
                <div className="pv-step-scope mono">{it.scope}</div>

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
            );
          })}
        </div>
      ))}
    </div>
  );
}
