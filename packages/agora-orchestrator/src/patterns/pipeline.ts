import type { Pattern } from '../contracts/pattern.js';
import type { GateConfig } from '../contracts/pattern.js';
import { respawnLineage } from './respawn.js';

const isGateConfig = (v: unknown): v is GateConfig =>
  !!v && typeof v === 'object' && 'onRed' in v && 'subject' in v;

export const pipeline: Pattern = {
  id: 'pipeline',
  /** Chain: each item with depends_on [] (except the first) depends on the previous item. */
  plan: (run) => ({
    ...run,
    items: run.items.map((it, i) =>
      i > 0 && it.depends_on.length === 0
        ? { ...it, depends_on: [run.items[i - 1]!.id] }
        : it,
    ),
  }),
  onTaskDone: (item, ctx) => {
    if (item.status === 'cancelled') return null;                  // operator intent
    const gate = item.inputs['gate'];
    if (!isGateConfig(gate) || gate.onRed !== 'spawn-fix') return null;
    const red = item.status === 'failed' || (item.status === 'done' && item.verify?.passed === false);
    if (!red) return null;
    const items = respawnLineage({ gate: item, config: gate, runItems: ctx.runItems });
    return items.length > 0 ? { items } : null;
  },
};
