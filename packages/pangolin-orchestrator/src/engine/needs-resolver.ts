import type { ItemState, OutputSelector } from '../contracts/types.js';

/** Selects the upstream product ref for one binding. undefined = product missing. */
export function selectProductRef(upstream: ItemState, sel: OutputSelector): string | undefined {
  if (sel.kind === 'patch') return upstream.resultRef;
  return upstream.outputRefs?.[sel.path];
}

/** PURE resolve-at-fire (spec §4): map each needs binding to its upstream product ref.
 *  Mirrors dep-resolver/lock-manager — no store, no IO; tick passes the items it already fetched. */
export function resolveInputRefs(
  item: ItemState,
  byId: Map<string, ItemState>,
): { inputRefs: Record<string, string> } | { error: string } {
  const inputRefs: Record<string, string> = {};
  for (const [key, binding] of Object.entries(item.needs ?? {})) {
    const upstream = byId.get(binding.from);
    if (!upstream) return { error: `unresolved needs '${key}': unknown upstream '${binding.from}'` };
    const ref = selectProductRef(upstream, binding.select);
    if (!ref) return { error: `unresolved needs '${key}': upstream '${binding.from}' has no such product` };
    inputRefs[key] = ref;
  }
  return { inputRefs };
}
