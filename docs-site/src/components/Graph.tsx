import { useRef, useState, useLayoutEffect, useCallback } from 'react';
import { topoOrder, type DemoItem, type NodeStatus } from '../lib/sealVerify';

export function ScaleMark({ state }: { state: string }) {
  return (
    <svg className={'pv-scale is-' + state} viewBox="0 0 28 28" width="22" height="22" aria-hidden="true">
      <path className="pv-s pv-s3" d="M4 17 q10 -9 20 0 q-10 5 -20 0Z" />
      <path className="pv-s pv-s2" d="M6 12 q8 -8 16 0 q-8 5 -16 0Z" />
      <path className="pv-s pv-s1" d="M8 7 q6 -6 12 0 q-6 4 -12 0Z" />
      {(state === 'tampered' || state === 'broken') && (
        <path className="pv-crack" d="M14 4 L11 14 L16 16 L13 24" />
      )}
    </svg>
  );
}

function StatusDot({ status }: { status: string }) {
  const map: Record<string, string> = { verified: 'Sealed', tampered: 'Tampered', broken: 'Broken' };
  return <span className={'pv-dot is-' + status}>{map[status] ?? '…'}</span>;
}

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

interface Edge { from: string; to: string; x1: number; y1: number; x2: number; y2: number; }

function Node({ item, status, selected, onSelect, refCb }: {
  item: DemoItem; status: NodeStatus; selected: boolean;
  onSelect: (id: string) => void; refCb: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <button ref={refCb} onClick={() => onSelect(item.id)}
      className={`pv-node is-${status}` + (selected ? ' is-selected' : '')}>
      <div className="pv-node-top">
        <ScaleMark state={status} />
        <span className="pv-node-action mono">{item.action}</span>
      </div>
      <div className="pv-node-label">{item.label}</div>
      <div className="pv-node-foot">
        <span className="pv-node-cred mono">{item.scope}</span>
        <StatusDot status={status} />
      </div>
    </button>
  );
}

export function Graph({ items, statuses, selected, onSelect }: {
  items: DemoItem[]; statuses: Record<string, NodeStatus>;
  selected: string; onSelect: (id: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [edges, setEdges] = useState<Edge[]>([]);
  const byId = Object.fromEntries(items.map((i) => [i.id, i])) as Record<string, DemoItem>;
  const levels = levelsOf(items);

  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const wb = wrap.getBoundingClientRect();
    const lines: Edge[] = [];
    for (const it of items) {
      const child = nodeRefs.current[it.id];
      if (!child) continue;
      const cb = child.getBoundingClientRect();
      for (const p of it.parents) {
        const par = nodeRefs.current[p];
        if (!par) continue;
        const pb = par.getBoundingClientRect();
        lines.push({
          from: p, to: it.id,
          x1: pb.right - wb.left, y1: pb.top - wb.top + pb.height / 2,
          x2: cb.left - wb.left, y2: cb.top - wb.top + cb.height / 2,
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

  const edgeState = (e: Edge): string => {
    const s = statuses[e.from];
    if (!s) return 'idle';
    return s === 'tampered' || s === 'broken' ? 'broken' : 'ok';
  };

  return (
    <div className="pv-graphwrap" ref={wrapRef}>
      <svg className="pv-edges" aria-hidden="true">
        {edges.map((e, i) => {
          const mx = (e.x1 + e.x2) / 2;
          return (
            <path key={i} className={'pv-edge is-' + edgeState(e)}
              d={`M ${e.x1} ${e.y1} C ${mx} ${e.y1}, ${mx} ${e.y2}, ${e.x2} ${e.y2}`} />
          );
        })}
      </svg>
      <div className="pv-levels">
        {levels.map((lvl, i) => (
          <div className="pv-level" key={i}>
            {lvl.map((id) => (
              <Node key={id} item={byId[id]} status={statuses[id] ?? 'verified'}
                selected={selected === id} onSelect={onSelect}
                refCb={(el) => { nodeRefs.current[id] = el; }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
