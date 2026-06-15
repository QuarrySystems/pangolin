# Provability Interactive Verifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a faithful, browser-interactive "Provability" demo in the docs-site that lets a visitor tamper a sealed audit bundle, flip the anchor tier, and re-seal as an attacker — watching the real `VerificationReport` claim respond truthfully.

**Architecture:** A React island in the Astro/Starlight docs-site. All verification logic is a pure, framework-free, unit-tested module (`lib/sealVerify.ts`) that returns the *real* `VerificationReport` type (type-only import from `@quarry-systems/pangolin-core`). The anchor is simulated in-browser behind one named seam; hashing is real SHA-256. Presentation is split into focused sub-components.

**Tech Stack:** Astro 6 + Starlight, `@astrojs/react`, React 18, `lucide-react`, Web Crypto (`crypto.subtle`), vitest (Node env), `@quarry-systems/pangolin-core` (workspace, type-only at runtime).

**Source spec:** `docs/superpowers/specs/2026-06-15-provability-interactive-verifier-design.md` (audited; all contract claims cite file:line).

**Base artifact:** The original mock component authored in the design thread is the visual starting point for Task 5. This plan extracts its logic into `lib/`, makes it faithful, and splits the presentation.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `docs-site/package.json` | deps + `test` script | 1 |
| `docs-site/astro.config.mjs` | register `react()`, add sidebar entry | 1, 6 |
| `docs-site/vitest.config.ts` | Node-env test runner | 1 |
| `docs-site/src/lib/sealVerify.ts` | pure: hashing, sealing, `deriveReport`, mirrored `claimFor`, anchor sim | 2, 3 |
| `docs-site/src/lib/sealVerify.test.ts` | unit tests + parity guard | 2, 3 |
| `docs-site/src/lib/demoBundle.ts` | synthetic change-order plan + tamper presets | 4 |
| `docs-site/src/lib/demoBundle.test.ts` | data sanity | 4 |
| `docs-site/src/components/ProvabilityVerifier.tsx` | state orchestration + layout | 5 |
| `docs-site/src/components/Graph.tsx` | DAG + measured SVG edges | 5 |
| `docs-site/src/components/Verdict.tsx` | two-axis verdict + checklist | 5 |
| `docs-site/src/components/Detail.tsx` | selected-node fields + hashes | 5 |
| `docs-site/src/components/verifier.css` | extracted styles | 5 |
| `docs-site/src/content/docs/provability.mdx` | the page hosting the island | 6 |
| `docs-site/src/content/docs/explanation/audit-guarantee-tiers.md` → `.mdx` | embed island inline | 7 |

---

### Task 1: Scaffold — React island, workspace dep, vitest

**Files:**
- Modify: `docs-site/package.json`
- Modify: `docs-site/astro.config.mjs`
- Create: `docs-site/vitest.config.ts`

- [ ] **Step 1: Add the React integration via the official installer**

Run (from repo root):

```bash
cd docs-site && npx astro add react --yes
```

Expected: installs `@astrojs/react`, `react`, `react-dom` (compatible versions for Astro 6) and inserts `react()` into the `integrations` array of `astro.config.mjs`. Confirm the import `import react from '@astrojs/react';` and `react()` now appear in `astro.config.mjs`.

- [ ] **Step 2: Add remaining deps (icons, workspace core, vitest)**

Run (from `docs-site/`):

```bash
pnpm add lucide-react @quarry-systems/pangolin-core@workspace:*
pnpm add -D vitest @types/react @types/react-dom
```

Expected: `package.json` `dependencies` gains `lucide-react` and `@quarry-systems/pangolin-core: "workspace:*"`; `devDependencies` gains `vitest`, `@types/react`, `@types/react-dom`.

- [ ] **Step 3: Add the `test` script**

In `docs-site/package.json`, add to `scripts`:

```json
"test": "vitest run"
```

(This auto-joins the repo gate: `pnpm-workspace.yaml` lists `docs-site` and root `test` is `pnpm -r run test`.)

- [ ] **Step 4: Create the vitest config (Node env — Web Crypto is global in Node 18+)**

Create `docs-site/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: Build the core dependency so its dist + types resolve**

Run (from repo root):

```bash
pnpm --filter @quarry-systems/pangolin-core build
```

Expected: `packages/pangolin-core/dist/index.d.ts` and `dist/index.js` exist (the `import type` and the test's runtime `claimFor` import both resolve to dist).

- [ ] **Step 6: Verify the toolchain is wired (empty test run + build)**

Run (from `docs-site/`):

```bash
pnpm test
pnpm build
```

Expected: `vitest` reports "No test files found" (exit 0 — acceptable at this point); `astro build` succeeds with the React integration registered.

- [ ] **Step 7: Commit**

```bash
git add docs-site/package.json docs-site/astro.config.mjs docs-site/vitest.config.ts pnpm-lock.yaml
git commit -m "build(docs-site): add React island toolchain + vitest + pangolin-core workspace dep"
```

---

### Task 2: Pure sealing core — hashing, topo order, seal

**Files:**
- Create: `docs-site/src/lib/sealVerify.ts`
- Test: `docs-site/src/lib/sealVerify.test.ts`

- [ ] **Step 1: Write the failing tests for sealing determinism + topo order**

Create `docs-site/src/lib/sealVerify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sha256Hex, ownString, topoOrder, sealBundle, type DemoItem } from './sealVerify';

const items: DemoItem[] = [
  { id: 'd0', label: 'Ingest', executor: 'dispatch', action: 'intent.ingest', parents: [],
    inputPayload: 'raw', outputPayload: 'structured', scope: 'read:intake', secretRef: 'tok_a' },
  { id: 'd1', label: 'Price', executor: 'dispatch', action: 'compute.cost', parents: ['d0'],
    inputPayload: 'lines', outputPayload: 'cost=5', scope: 'read:rates', secretRef: 'tok_b' },
  { id: 'd2', label: 'Emit', executor: 'dispatch', action: 'emit.amend', parents: ['d1'],
    inputPayload: 'pkt', outputPayload: 'amend.pdf', scope: 'write:amend', secretRef: 'tok_c' },
];

describe('sha256Hex', () => {
  it('is the real SHA-256 of the input', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('topoOrder', () => {
  it('orders parents before children', () => {
    const order = topoOrder(items);
    expect(order.indexOf('d0')).toBeLessThan(order.indexOf('d1'));
    expect(order.indexOf('d1')).toBeLessThan(order.indexOf('d2'));
  });
  it('throws on a cycle', () => {
    const cyclic: DemoItem[] = [
      { ...items[0], id: 'a', parents: ['b'] },
      { ...items[1], id: 'b', parents: ['a'] },
    ];
    expect(() => topoOrder(cyclic)).toThrow(/cycle/);
  });
});

describe('sealBundle', () => {
  it('is deterministic for identical input', async () => {
    const a = await sealBundle(items);
    const b = await sealBundle(items);
    expect(a.root).toBe(b.root);
  });
  it('changes the root when any own-field changes', async () => {
    const a = await sealBundle(items);
    const mutated = items.map((i) => (i.id === 'd1' ? { ...i, outputPayload: 'cost=999' } : i));
    const b = await sealBundle(mutated);
    expect(b.root).not.toBe(a.root);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `docs-site/`): `pnpm test`
Expected: FAIL — `Cannot find module './sealVerify'` / exports undefined.

- [ ] **Step 3: Implement the sealing core**

Create `docs-site/src/lib/sealVerify.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `docs-site/`): `pnpm test`
Expected: PASS (all of Task 2's tests green).

- [ ] **Step 5: Commit**

```bash
git add docs-site/src/lib/sealVerify.ts docs-site/src/lib/sealVerify.test.ts
git commit -m "feat(provability): pure sealing core (sha256, topo order, sealBundle)"
```

---

### Task 3: `deriveReport`, anchor sim, reseal, node statuses + parity guard

**Files:**
- Modify: `docs-site/src/lib/sealVerify.ts`
- Modify: `docs-site/src/lib/sealVerify.test.ts`

- [ ] **Step 1: Write the failing tests (7 scenarios + parity guard + node ripple)**

Append to `docs-site/src/lib/sealVerify.test.ts`:

```ts
import { claimFor } from '@quarry-systems/pangolin-core'; // REAL rule (Node test env → Buffer ok)
import {
  sealHonest, deriveReport, reseal, applyTamper, nodeStatuses, claimFor as mirroredClaimFor,
  type DemoState,
} from './sealVerify';

async function freshState(tier: DemoState['tier']): Promise<DemoState> {
  return { sealed: await sealHonest(items), tier, timeAttested: false };
}

describe('deriveReport — clean bundle', () => {
  it('local → tamper-detecting, signature n/a, intact', async () => {
    const r = await deriveReport(await freshState('local'));
    expect(r.intact).toBe(true);
    expect(r.claim).toBe('tamper-detecting');
    expect(r.checks.signature.ok).toBe('n/a');
    expect(r.guarantee).toBe('detect');
  });
  it('s3-worm → tamper-evident, signature true', async () => {
    const r = await deriveReport(await freshState('s3-worm'));
    expect(r.claim).toBe('tamper-evident');
    expect(r.checks.signature.ok).toBe(true);
    expect(r.guarantee).toBe('external-immutable');
  });
  it('time axis is orthogonal — attesting time never changes the tamper claim', async () => {
    const s = { ...(await freshState('s3-worm')), timeAttested: true };
    const r = await deriveReport(s);
    expect(r.claim).toBe('tamper-evident');
    expect(r.timeTier).toBe('tsa-attested');
  });
  it('rank gate: a signed WORM bundle flipped to local downgrades by RANK, not signature', async () => {
    const worm = await freshState('s3-worm');
    const local = { ...worm, tier: 'local' as const };
    expect((await deriveReport(local)).claim).toBe('tamper-detecting');
  });
});

describe('deriveReport — tamper + reseal', () => {
  it('tamper without reseal → not intact, failure chain', async () => {
    const s = await freshState('s3-worm');
    s.sealed.items = applyTamper(s.sealed.items, 'd1', 'outputPayload', 'cost=99999');
    const r = await deriveReport(s);
    expect(r.intact).toBe(false);
    expect(r.failure).toBe('chain');
  });
  it('local: attacker reseal succeeds (intact, tamper-detecting)', async () => {
    let s = await freshState('local');
    s.sealed.items = applyTamper(s.sealed.items, 'd1', 'outputPayload', 'cost=99999');
    s = await reseal(s);
    const r = await deriveReport(s);
    expect(r.intact).toBe(true);
    expect(r.claim).toBe('tamper-detecting');
  });
  it('s3-worm: attacker reseal caught with root-mismatch', async () => {
    let s = await freshState('s3-worm');
    s.sealed.items = applyTamper(s.sealed.items, 'd1', 'outputPayload', 'cost=99999');
    s = await reseal(s);
    const r = await deriveReport(s);
    expect(r.intact).toBe(false);
    expect(r.failure).toBe('root-mismatch');
  });
});

describe('nodeStatuses — ripple', () => {
  it('tampering a parent marks it tampered and descendants broken', async () => {
    const s = await freshState('local');
    s.sealed.items = applyTamper(s.sealed.items, 'd1', 'outputPayload', 'cost=99999');
    const st = await nodeStatuses(s);
    expect(st.d0).toBe('verified');
    expect(st.d1).toBe('tampered');
    expect(st.d2).toBe('broken');
  });
});

describe('claimFor parity guard', () => {
  it('mirrored rule matches the real pangolin-core claimFor for all combos', () => {
    const guarantees = ['detect', 'external-immutable', 'witnessed'] as const;
    const sigs = [true, false, 'n/a'] as const;
    for (const intact of [true, false])
      for (const g of guarantees)
        for (const sig of sigs)
          expect(mirroredClaimFor(intact, g, sig)).toBe(claimFor(intact, g, sig));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `docs-site/`): `pnpm test`
Expected: FAIL — `sealHonest`, `deriveReport`, `reseal`, `applyTamper`, `nodeStatuses`, `claimFor` not exported.

- [ ] **Step 3: Implement the report derivation + anchor sim**

Append to `docs-site/src/lib/sealVerify.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `docs-site/`): `pnpm test`
Expected: PASS — all 7 scenario tests, the ripple test, and the parity guard green.

- [ ] **Step 5: Commit**

```bash
git add docs-site/src/lib/sealVerify.ts docs-site/src/lib/sealVerify.test.ts
git commit -m "feat(provability): deriveReport + anchor sim + reseal + claimFor parity guard"
```

---

### Task 4: Demo data — the synthetic change-order plan

**Files:**
- Create: `docs-site/src/lib/demoBundle.ts`
- Test: `docs-site/src/lib/demoBundle.test.ts`

- [ ] **Step 1: Write the failing data-sanity test**

Create `docs-site/src/lib/demoBundle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PRISTINE_ITEMS, TAMPERS } from './demoBundle';
import { topoOrder } from './sealVerify';

describe('demoBundle', () => {
  it('is a valid acyclic plan', () => {
    expect(() => topoOrder(PRISTINE_ITEMS)).not.toThrow();
    expect(PRISTINE_ITEMS.length).toBeGreaterThanOrEqual(4);
  });
  it('every tamper targets a real item and a tamperable field', () => {
    const ids = new Set(PRISTINE_ITEMS.map((i) => i.id));
    for (const t of TAMPERS) {
      expect(ids.has(t.target)).toBe(true);
      expect(['outputPayload', 'scope']).toContain(t.field);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `docs-site/`): `pnpm test`
Expected: FAIL — `Cannot find module './demoBundle'`.

- [ ] **Step 3: Implement the demo data**

Create `docs-site/src/lib/demoBundle.ts`:

```ts
import type { DemoItem } from './sealVerify';

/** A change-order on a custom-home build: ingest → (contract, price) → authorize → emit. */
export const PRISTINE_ITEMS: DemoItem[] = [
  { id: 'd0', label: 'Ingest request', executor: 'dispatch', action: 'intent.ingest', parents: [],
    inputPayload: 'co-0142: relocate kitchen island + add 30A circuit',
    outputPayload: 'scope=electrical+millwork; ref=CO-0142', scope: 'read:intake', secretRef: 'tok_intake_1' },
  { id: 'd1', label: 'Pull contract scope', executor: 'dispatch', action: 'retrieve.contract', parents: ['d0'],
    inputPayload: 'contract=LRK-2025-11; rev=3',
    outputPayload: 'baseline_total=$842,000; allowance_electrical=$18,500', scope: 'read:contracts', secretRef: 'tok_contracts_7' },
  { id: 'd2', label: 'Price the change', executor: 'dispatch', action: 'compute.costdelta', parents: ['d0'],
    inputPayload: 'millwork=14h@$95; electrical=30A run + permit',
    outputPayload: 'cost_delta=$4,275; lead_time=+6 days', scope: 'read:ratecard', secretRef: 'tok_rates_2' },
  { id: 'd3', label: 'Authorize', executor: 'dispatch', action: 'authz.approve', parents: ['d1', 'd2'],
    inputPayload: 'delta=$4,275; approver=owner:r.castellanos',
    outputPayload: 'approved=true; basis=under_$5k_owner_authority', scope: 'approve:changeorder<=5000', secretRef: 'tok_authz_owner' },
  { id: 'd4', label: 'Issue amendment', executor: 'dispatch', action: 'emit.amendment', parents: ['d3'],
    inputPayload: 'co=CO-0142; delta=$4,275; approved=true',
    outputPayload: 'amendment=AMD-0142.pdf; notified=owner,gc,sub', scope: 'write:amendments', secretRef: 'tok_amend_4' },
];

export interface TamperPreset {
  id: string;
  label: string;
  target: string;
  field: 'outputPayload' | 'scope';
  value: string;
}

export const TAMPERS: TamperPreset[] = [
  { id: 'price', label: 'Alter the agreed price', target: 'd2', field: 'outputPayload',
    value: 'cost_delta=$11,900; lead_time=+6 days' },
  { id: 'authz', label: 'Forge approval authority', target: 'd3', field: 'scope',
    value: 'approve:changeorder<=50000' },
  { id: 'scope', label: 'Rewrite delivered scope', target: 'd4', field: 'outputPayload',
    value: 'amendment=AMD-0142.pdf; notified=owner' },
];
```

- [ ] **Step 4: Run to verify it passes**

Run (from `docs-site/`): `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs-site/src/lib/demoBundle.ts docs-site/src/lib/demoBundle.test.ts
git commit -m "feat(provability): synthetic change-order plan + tamper presets"
```

---

### Task 5: Presentation — port the mock onto the pure core, split components

**Files:**
- Create: `docs-site/src/components/ProvabilityVerifier.tsx`
- Create: `docs-site/src/components/Graph.tsx`
- Create: `docs-site/src/components/Verdict.tsx`
- Create: `docs-site/src/components/Detail.tsx`
- Create: `docs-site/src/components/verifier.css`

This task ports the design-thread mock's *presentation* (dark palette, scale mark, DAG with measured SVG edges, ripple animation) onto the pure core from Tasks 2–4. The mock's two sealing `useEffect`s and inline crypto are **removed** — all hashing/verdict logic now comes from `sealVerify.ts`. No verdict value is hard-coded in JSX; everything renders from `deriveReport`/`nodeStatuses`.

- [ ] **Step 1: Extract the mock's CSS verbatim into `verifier.css`**

Create `docs-site/src/components/verifier.css` and paste the mock's CSS string body (everything inside the original `const CSS = \`…\``), unchanged. Add two new style rules for the controls introduced this task:

```css
/* anchor-tier toggle + reseal control */
.pv-tier{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--line2);border-radius:9px;padding:4px;}
.pv-tier button{font:inherit;font-size:12px;color:var(--muted);background:transparent;border:0;padding:5px 10px;border-radius:6px;cursor:pointer;}
.pv-tier button.is-on{background:var(--panel2);color:var(--text);}
.pv-reseal{display:inline-flex;gap:6px;align-items:center;font-size:12.5px;color:var(--red);background:var(--red-dim);border:1px solid var(--red-line);padding:8px 13px;border-radius:9px;cursor:pointer;}
.pv-axis{display:flex;gap:10px;flex-wrap:wrap;align-items:center;}
.pv-axis-badge{font-size:11px;letter-spacing:.04em;padding:3px 9px;border-radius:20px;border:1px solid var(--line2);color:var(--muted);}
.pv-axis-badge.is-evident{color:var(--teal);background:var(--teal-dim);border-color:var(--teal-line);}
.pv-axis-badge.is-attested{color:var(--teal);background:var(--teal-dim);border-color:var(--teal-line);}
.pv-caption{font-size:12.5px;margin:10px 0 0;padding:9px 12px;border-radius:9px;}
.pv-caption.is-bad{color:var(--red);background:var(--red-dim);}
.pv-caption.is-ok{color:var(--teal);background:var(--teal-dim);}
.pv-check{display:flex;gap:10px;align-items:baseline;font-size:12.5px;padding:3px 0;}
.pv-check .mono{color:var(--muted);}
.pv-check.is-fail{color:var(--red);} .pv-check.is-ok{color:var(--teal);} .pv-check.is-na{color:var(--dim);}
```

- [ ] **Step 2: Create the Graph sub-component (DAG + measured edges)**

Create `docs-site/src/components/Graph.tsx` by moving the mock's `Graph`, `Node`, `StatusDot`, and `ScaleMark` functions into it. Change the data source: instead of the mock's `data.dispatches`, accept props `{ items, statuses, selected, onSelect }` where `items: DemoItem[]` and `statuses: Record<string, NodeStatus>`. Replace every `d.dispatches`/`d.parents` access with the `DemoItem` fields (`it.parents`, `it.action`, `it.scope`). Derive levels from `topoOrder` depth instead of the hard-coded `LEVELS`:

```tsx
import { useRef, useState, useLayoutEffect, useCallback } from 'react';
import { topoOrder, type DemoItem, type NodeStatus } from '../lib/sealVerify';

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
```

Keep the existing `ResizeObserver` edge-measuring logic verbatim (it already reads `nodeRefs` by id). Export `Graph` as the default/named export. (`ScaleMark` and `StatusDot` move here as local helpers; also export `ScaleMark` for reuse by Verdict.)

- [ ] **Step 3: Create the Verdict sub-component (two axes + checklist)**

Create `docs-site/src/components/Verdict.tsx`:

```tsx
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
```

- [ ] **Step 4: Create the Detail sub-component**

Create `docs-site/src/components/Detail.tsx` by moving the mock's `Detail` and `Field` functions into it, retyped to `DemoItem`. The editable fields call `onEdit(id, 'outputPayload' | 'scope', value)`. Replace the mock's `d.output.payload`/`d.credential.scope` with `it.outputPayload`/`it.scope`, and show `it.secretRef` (read-only) labelled "secretRef (reference — value never sealed)". Props: `{ item, status, onEdit }`.

- [ ] **Step 5: Create the container that wires state to the pure core**

Create `docs-site/src/components/ProvabilityVerifier.tsx`:

```tsx
import { useEffect, useState, useCallback } from 'react';
import { Zap, RotateCcw } from 'lucide-react';
import {
  sealHonest, deriveReport, reseal, applyTamper, nodeStatuses,
  type DemoState, type NodeStatus,
} from '../lib/sealVerify';
import type { VerificationReport } from '@quarry-systems/pangolin-core';
import { PRISTINE_ITEMS, TAMPERS } from '../lib/demoBundle';
import { Graph } from './Graph';
import { Verdict } from './Verdict';
import { Detail } from './Detail';
import './verifier.css';

export default function ProvabilityVerifier() {
  const [state, setState] = useState<DemoState | null>(null);
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [statuses, setStatuses] = useState<Record<string, NodeStatus>>({});
  const [selected, setSelected] = useState('d2');
  const [tampered, setTampered] = useState(false);

  // Honest seal on mount.
  useEffect(() => {
    (async () => {
      setState({ sealed: await sealHonest(PRISTINE_ITEMS), tier: 's3-worm', timeAttested: false });
    })();
  }, []);

  // Re-derive report + node statuses whenever state changes.
  useEffect(() => {
    if (!state) return;
    let live = true;
    (async () => {
      const [r, st] = await Promise.all([deriveReport(state), nodeStatuses(state)]);
      if (live) { setReport(r); setStatuses(st); }
    })();
    return () => { live = false; };
  }, [state]);

  const editItems = useCallback((next: DemoState['sealed']['items']) => {
    setState((s) => (s ? { ...s, sealed: { ...s.sealed, items: next } } : s));
    setTampered(true);
  }, []);

  const onPreset = (t: (typeof TAMPERS)[number]) => {
    setState((s) => (s ? { ...s, sealed: { ...s.sealed, items: applyTamper(s.sealed.items, t.target, t.field, t.value) } } : s));
    setSelected(t.target);
    setTampered(true);
  };
  const onEdit = (id: string, field: 'outputPayload' | 'scope', value: string) =>
    editItems(applyTamper(state!.sealed.items, id, field, value));
  const onReseal = async () => { if (state) setState(await reseal(state)); };
  const onRestore = async () => {
    setState({ sealed: await sealHonest(PRISTINE_ITEMS), tier: state?.tier ?? 's3-worm', timeAttested: state?.timeAttested ?? false });
    setTampered(false);
  };
  const setTier = (tier: DemoState['tier']) => setState((s) => (s ? { ...s, tier } : s));
  const toggleTime = () => setState((s) => (s ? { ...s, timeAttested: !s.timeAttested } : s));

  if (!state || !report) return <div className="pv-root">Loading…</div>;
  const sel = state.sealed.items.find((i) => i.id === selected)!;
  const resealCaption =
    tampered && report.intact && state.tier === 'local'
      ? { cls: 'is-bad', text: 'The root lives in the same store the attacker controls — rewrite the log, rewrite the root. The local tier proves consistency, not immutability. That is why it only ever claims tamper-detecting.' }
      : tampered && report.failure === 'root-mismatch'
        ? { cls: 'is-ok', text: 'The anchored root is in a separate trust domain (WORM). The attacker rewrote the bundle — but not the anchor. That is tamper-evident.' }
        : null;

  return (
    <div className="pv-root">
      <header className="pv-header">
        <div className="pv-brand"><div><div className="pv-eyebrow">Audit bundle verifier</div><div className="pv-wordmark">Pangolin</div></div></div>
        <Verdict report={report} />
      </header>

      <section className="pv-controls">
        <span className="pv-ctl-label"><Zap size={13} /> Try to break the seal</span>
        <div className="pv-ctl-btns">
          {TAMPERS.map((t) => (
            <button key={t.id} className="pv-tamper" onClick={() => onPreset(t)}>{t.label}</button>
          ))}
          {tampered && <button className="pv-reseal" onClick={onReseal}>Re-seal the bundle (act as the attacker)</button>}
          <button className="pv-restore" onClick={onRestore}><RotateCcw size={13} /> Restore bundle</button>
        </div>
      </section>

      <section className="pv-controls">
        <span className="pv-ctl-label">Anchor</span>
        <div className="pv-tier">
          <button className={state.tier === 'local' ? 'is-on' : ''} onClick={() => setTier('local')}>LocalAnchor · detect</button>
          <button className={state.tier === 's3-worm' ? 'is-on' : ''} onClick={() => setTier('s3-worm')}>S3 Object Lock · external-immutable</button>
        </div>
        <label className="pv-ctl-label"><input type="checkbox" checked={state.timeAttested} onChange={toggleTime} /> Attach RFC-3161 timestamp</label>
      </section>

      {resealCaption && <p className={'pv-caption ' + resealCaption.cls}>{resealCaption.text}</p>}

      <Graph items={state.sealed.items} statuses={statuses} selected={selected} onSelect={setSelected} />
      <Detail item={sel} status={statuses[selected] ?? 'verified'} onEdit={onEdit} />

      <footer className="pv-footer">
        Real SHA-256, computed in your browser. The anchor is simulated; the verdict is the
        production <code>VerificationReport</code> shape and <code>claimFor</code> rule.
      </footer>
    </div>
  );
}
```

- [ ] **Step 6: Typecheck + build**

Run (from `docs-site/`): `pnpm build`
Expected: `astro build` succeeds (no TS errors; the island compiles).

- [ ] **Step 7: Commit**

```bash
git add docs-site/src/components/
git commit -m "feat(provability): port verifier UI onto pure core; split Graph/Verdict/Detail"
```

---

### Task 6: The Provability page + nav

**Files:**
- Create: `docs-site/src/content/docs/provability.mdx`
- Modify: `docs-site/astro.config.mjs`

- [ ] **Step 1: Create the page hosting the island**

Create `docs-site/src/content/docs/provability.mdx`:

```mdx
---
title: Provability
description: Try to break a Pangolin audit seal — tamper a bundle, flip the anchor tier, and watch the claim respond truthfully.
---

import ProvabilityVerifier from '../../components/ProvabilityVerifier.tsx';

Pangolin's audit trail does not ask you to take "tamper-evident" on trust. Below is a real
verifier over a sealed change-order bundle. Tamper a field, flip the anchor tier, and — once
you have tampered — try to **re-seal as the attacker**. The verdict is the production
`VerificationReport`: a tamper axis and a separate time axis, with the claim downgrading
exactly when the real rule says it must.

<ProvabilityVerifier client:only="react" />

## What you just saw

- **Tampering breaks the chain.** Each step's hash folds in its inputs; change one sealed
  field and the break ripples downstream to the root.
- **The tier decides the ceiling.** On `LocalAnchor` the root lives in the same store as the
  log, so it can only ever claim **tamper-detecting**. On `S3 Object Lock` the root is external
  and immutable, earning **tamper-evident** — see [Audit & guarantee tiers](/pangolin/explanation/audit-guarantee-tiers/).
- **Re-sealing is the proof.** On the local tier the attacker rewrites the root and gets away
  with it; on WORM the frozen anchored root no longer matches and verification fails with
  `root-mismatch`. That is the whole difference.

To verify a real exported bundle, see [Export & verify an audit bundle](/pangolin/how-to/verify-audit-bundle/).
```

- [ ] **Step 2: Register the page in the sidebar (top-level, high placement)**

In `docs-site/astro.config.mjs`, add a top-level entry to the `sidebar` array, immediately before the `'Use cases'` group:

```js
{ label: 'Provability', slug: 'provability' },
```

- [ ] **Step 3: Build (this also runs the link validator)**

Run (from `docs-site/`): `pnpm build`
Expected: build succeeds; `starlightLinksValidator` passes (the new slug is registered and the three internal links resolve).

- [ ] **Step 4: Commit**

```bash
git add docs-site/src/content/docs/provability.mdx docs-site/astro.config.mjs
git commit -m "feat(provability): add Provability page + top-level nav entry"
```

---

### Task 7: Embed the island in the explainer

**Files:**
- Rename + modify: `docs-site/src/content/docs/explanation/audit-guarantee-tiers.md` → `.mdx`

- [ ] **Step 1: Rename the explainer to `.mdx` so it can import the island**

Run (from repo root):

```bash
git mv docs-site/src/content/docs/explanation/audit-guarantee-tiers.md docs-site/src/content/docs/explanation/audit-guarantee-tiers.mdx
```

- [ ] **Step 2: Import and embed the island after "The two claims" section**

At the top of the file body (just under the frontmatter), add:

```mdx
import ProvabilityVerifier from '../../../components/ProvabilityVerifier.tsx';
```

Immediately after the "## The two claims" section's table, insert:

```mdx
The rule below is not just described — it is executable. Tamper the bundle and flip the
anchor tier; the claim moves exactly as `claimFor` dictates.

<ProvabilityVerifier client:only="react" />
```

- [ ] **Step 3: Build to confirm the rename + import + links still validate**

Run (from `docs-site/`): `pnpm build`
Expected: build succeeds; no broken links (the slug `explanation/audit-guarantee-tiers` is unchanged by the extension swap, so existing inbound links still resolve).

- [ ] **Step 4: Commit**

```bash
git add docs-site/src/content/docs/explanation/audit-guarantee-tiers.mdx
git commit -m "docs(provability): embed live verifier in audit-guarantee-tiers explainer"
```

---

### Task 8: Full verification + visual smoke

**Files:** none (verification only)

- [ ] **Step 1: Run the full repo test gate**

Run (from repo root): `pnpm -r run test`
Expected: PASS, including the new `docs-site` suite (sealVerify + demoBundle).

- [ ] **Step 2: Production build**

Run (from `docs-site/`): `pnpm build`
Expected: clean build, link validator green.

- [ ] **Step 3: Visual smoke in a real browser**

Run (from `docs-site/`): `pnpm dev`, open the `/pangolin/provability/` page, and confirm:
- The DAG renders with measured edges and the pangolin scale marks.
- Clicking **Alter the agreed price** marks `d2` tampered (red), `d3`/`d4` broken (amber), and the verdict flips to "Tamper detected · first failing check: chain".
- With a tamper applied on **S3 Object Lock**, **Re-seal** yields `root-mismatch` and the green WORM caption.
- Switching the anchor to **LocalAnchor** then **Re-seal** returns the verdict to green with the red local caption.
- On a clean bundle, toggling the anchor flips the tamper badge between `tamper-detecting` and `tamper-evident`; toggling **Attach RFC-3161 timestamp** flips only the time badge, never the tamper badge.

- [ ] **Step 4: Final commit (if any smoke fixes were needed)**

```bash
git add -A
git commit -m "fix(provability): visual smoke adjustments"
```

(If no fixes were needed, skip.)

---

## Notes for the executor

- **Run all `pnpm` commands from `docs-site/`** unless a step says "repo root".
- **`crypto.subtle` and `TextEncoder` are global** in the Node vitest env (Node 18+) and in the browser — no polyfill, no jsdom needed.
- **`import type` is erased at build**, so the browser bundle never pulls `@quarry-systems/pangolin-core` runtime code; only the Node parity test imports the real `claimFor` (Buffer is fine there).
- If `pnpm --filter @quarry-systems/pangolin-core build` was skipped, the parity test's `claimFor` import and the type imports may fail to resolve — build core first (STALE-DIST).
- **Never hard-code a verdict in JSX.** Every claim/status renders from `deriveReport`/`nodeStatuses` so the UI cannot contradict the rule (spec §11).
