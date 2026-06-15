// Pure, framework-free verification core for the Provability demo.
// Hashing is real SHA-256. The report SHAPE is the production type (type-only import,
// erased at build → zero runtime dep on pangolin-core in the browser bundle).
import type { VerificationReport, Guarantee, TimeTier } from '@quarry-systems/pangolin-core';

const US = '␟'; // unit separator, matches the audit canon's field delimiter

export interface DemoItem {
  id: string;
  label: string;
  executor: string;       // real DispatchManifest field (NOT "adapter")
  action: string;         // executorManifest action label
  parents: string[];      // WorkItem.depends_on
  inputPayload: string;   // decoded inputRef (annotation)
  outputPayload: string;  // decoded resultRef (annotation; bundle seals the ref, not the value)
  scope: string;          // credential grant scope
  secretRef: string;      // an entry of DispatchManifest.secretRefs (tok_*)
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The sealed own-fields of one item (independent of parents). */
export function ownString(it: DemoItem): string {
  return [it.executor, it.action, it.inputPayload, it.outputPayload, it.scope, it.secretRef].join(US);
}

/** Kahn topological sort over depends_on; throws on a cycle. */
export function topoOrder(items: DemoItem[]): string[] {
  const indeg = new Map(items.map((i) => [i.id, i.parents.length]));
  const children = new Map<string, string[]>();
  for (const i of items)
    for (const p of i.parents) children.set(p, [...(children.get(p) ?? []), i.id]);
  const queue = items.filter((i) => i.parents.length === 0).map((i) => i.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const c of children.get(id) ?? []) {
      indeg.set(c, indeg.get(c)! - 1);
      if (indeg.get(c) === 0) queue.push(c);
    }
  }
  if (order.length !== items.length) throw new Error('cycle in plan DAG');
  return order;
}

export interface SealResult {
  ownHashes: Record<string, string>;     // per-item own-field hash
  contentHashes: Record<string, string>; // per-item chained hash (folds in parents)
  root: string;                          // Merkle-style root over content hashes
}

/** Compute own + chained content hashes (parents folded in) and the root. */
export async function sealBundle(items: DemoItem[]): Promise<SealResult> {
  const order = topoOrder(items);
  const byId = new Map(items.map((i) => [i.id, i]));
  const ownHashes: Record<string, string> = {};
  const contentHashes: Record<string, string> = {};
  for (const id of order) {
    const it = byId.get(id)!;
    ownHashes[id] = await sha256Hex(ownString(it));
    const parentChain = it.parents.map((p) => contentHashes[p]).join('');
    contentHashes[id] = await sha256Hex(ownHashes[id] + US + parentChain);
  }
  // Root leaves in stable item-array order (deterministic).
  const root = await sha256Hex(items.map((i) => contentHashes[i.id]).join(''));
  return { ownHashes, contentHashes, root };
}
