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

export type AnchorTier = 'local' | 's3-worm';
export type NodeStatus = 'verified' | 'tampered' | 'broken';

export interface SealedState {
  items: DemoItem[];
  storedHashes: Record<string, string>;   // own-hash snapshot from last seal
  storedContent: Record<string, string>;  // content-hash snapshot from last seal
  anchoredRoot: string;                    // the root the anchor holds
  honestRoot: string;                      // original honest root (signature validity)
}

export interface DemoState {
  sealed: SealedState;
  tier: AnchorTier;
  timeAttested: boolean;
}

/** Honest seal of a fresh bundle: anchored root == recomputed root == honest root. */
export async function sealHonest(items: DemoItem[]): Promise<SealedState> {
  const { ownHashes, contentHashes, root } = await sealBundle(items);
  return {
    items: items.map((i) => ({ ...i })),
    storedHashes: ownHashes,
    storedContent: contentHashes,
    anchoredRoot: root,
    honestRoot: root,
  };
}

/** Pure field edit on a copy of the items (the only mutable demo surface). */
export function applyTamper(
  items: DemoItem[],
  id: string,
  field: 'outputPayload' | 'scope',
  value: string,
): DemoItem[] {
  return items.map((i) => (i.id === id ? { ...i, [field]: value } : i));
}

const GUARANTEE_RANK: Record<Guarantee, number> = { detect: 0, 'external-immutable': 1, witnessed: 2 };

/** Mirror of pangolin-core `claimFor` (audit-verify.ts:10-20). Guarded by the parity test —
 *  mirrored (not imported at runtime) to keep Node `Buffer` out of the browser bundle. */
export function claimFor(
  intact: boolean,
  guarantee: Guarantee,
  sigOk: boolean | 'n/a',
): 'tamper-evident' | 'tamper-detecting' {
  return intact &&
    GUARANTEE_RANK[guarantee] >= GUARANTEE_RANK['external-immutable'] &&
    sigOk === true
    ? 'tamper-evident'
    : 'tamper-detecting';
}

/** The single demo-specific deviation from production: simulate the anchor on reseal.
 *  local → attacker rewrites the co-located root; s3-worm → root is frozen (WORM). */
export async function reseal(state: DemoState): Promise<DemoState> {
  const { ownHashes, contentHashes, root } = await sealBundle(state.sealed.items);
  const sealed: SealedState = { ...state.sealed, storedHashes: ownHashes, storedContent: contentHashes };
  if (state.tier === 'local') sealed.anchoredRoot = root; // co-located store → rewritable
  // s3-worm: anchoredRoot stays frozen → root-mismatch on verify
  return { ...state, sealed };
}

/** Per-node status for the graph: tampered (own fields diverged) vs broken (intact own
 *  fields but depends on a tampered/broken node) vs verified. */
export async function nodeStatuses(state: DemoState): Promise<Record<string, NodeStatus>> {
  const { items, storedHashes } = state.sealed;
  const order = topoOrder(items);
  const byId = new Map(items.map((i) => [i.id, i]));
  const st: Record<string, 'ok' | 'tampered' | 'broken'> = {};
  for (const id of order) {
    const own = await sha256Hex(ownString(byId.get(id)!));
    st[id] = own !== storedHashes[id] ? 'tampered' : 'ok';
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of order) {
      if (st[id] === 'ok' && byId.get(id)!.parents.some((p) => st[p] === 'tampered' || st[p] === 'broken')) {
        st[id] = 'broken';
        changed = true;
      }
    }
  }
  return Object.fromEntries(
    order.map((id) => [id, st[id] === 'ok' ? 'verified' : st[id]]),
  ) as Record<string, NodeStatus>;
}

/** Derive the real VerificationReport from demo state (faithful to verify() semantics). */
export async function deriveReport(state: DemoState): Promise<VerificationReport> {
  const { sealed, tier, timeAttested } = state;
  const guarantee: Guarantee = tier === 's3-worm' ? 'external-immutable' : 'detect';
  const anchorId = tier === 's3-worm' ? 's3:demo-bucket' : 'local';

  // 1. chain: recompute own + content, compare to the stored snapshot.
  const order = topoOrder(sealed.items);
  const byId = new Map(sealed.items.map((i) => [i.id, i]));
  const content: Record<string, string> = {};
  let chainOk = true;
  let chainDetail: string | undefined;
  for (const id of order) {
    const it = byId.get(id)!;
    const own = await sha256Hex(ownString(it));
    content[id] = await sha256Hex(own + US + it.parents.map((p) => content[p]).join(''));
    if (chainOk && (own !== sealed.storedHashes[id] || content[id] !== sealed.storedContent[id])) {
      chainOk = false;
      chainDetail = `entry ${id} hash ≠ recomputed`;
    }
  }
  const recomputedRoot = await sha256Hex(sealed.items.map((i) => content[i.id]).join(''));

  // 2-5. anchor / root / signature / time
  const anchorOk = sealed.anchoredRoot.length > 0;
  const rootOk: boolean | 'n/a' = anchorOk ? recomputedRoot === sealed.anchoredRoot : 'n/a';
  // local default config carries no verified signature → 'n/a' (NOT because LocalAnchor strips
  // it — it does not; the rank gate is what keeps local tamper-detecting). s3-worm: valid iff
  // the anchored root is the honest signed root (the frozen one always is).
  const sigOk: boolean | 'n/a' = tier === 's3-worm' ? sealed.anchoredRoot === sealed.honestRoot : 'n/a';
  const timeOk: boolean | 'n/a' = timeAttested ? true : 'n/a';
  const timeTier: TimeTier = timeOk === true ? 'tsa-attested' : 'asserted';

  const intact = chainOk && anchorOk && rootOk !== false && sigOk !== false;
  const failure = !chainOk
    ? ('chain' as const)
    : !anchorOk
      ? ('anchor-missing' as const)
      : rootOk === false
        ? ('root-mismatch' as const)
        : sigOk === false
          ? ('signature' as const)
          : undefined;

  return {
    runId: 'run_larkspur_co0142',
    intact,
    anchorId,
    guarantee,
    claim: claimFor(intact, guarantee, sigOk),
    timeTier,
    failure,
    checks: {
      chain: { ok: chainOk, detail: chainDetail },
      root: { ok: rootOk },
      signature: { ok: sigOk },
      anchor: { ok: anchorOk },
      handoff: { ok: 'n/a' }, // verifyBundle-only; n/a for a single-run demo
      time: { ok: timeOk },
    },
  };
}
