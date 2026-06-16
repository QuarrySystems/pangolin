# Authorizer Seam + Authorization-in-Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dispatch-level `Authorizer` (allow/deny, fail-closed) consulted at submit (fail-fast) and fire (binding, sealed), so the audit seal proves *authorized → ran → produced*; report authorization as an orthogonal `authzTier` dimension; and close the pre-existing gap that lets sealed manifest fields be mutated undetected.

**Architecture:** Additive, mirroring the `Signer` seam — a dependency-light `Authorizer` interface in `pangolin-core`, `NoneAuthorizer` + an in-tree config authorizer in the orchestrator, external policy engines deferred to future `pangolin-authorizer-*` leaf packages. The decision is injected at two sites (orchestrator @ submit; `FireContext` @ fire). An allow seals an `authorization` block into the `DispatchManifest`; a deny blocks the dispatch, drives the item to a new terminal `denied` status, and seals an `item.denied` audit entry. A new **manifest-integrity check** in `verifyBundle` (recompute each manifest's content hash, compare to the chained `manifestRef`) makes the sealed evidence actually tamper-evident.

**Tech Stack:** TypeScript, pnpm workspace, vitest, `node:crypto` (no new deps). Spec: `docs/superpowers/specs/2026-06-16-authorizer-seam-authorization-in-evidence-design.md`.

---

## File structure

| File | Change | Responsibility |
|------|--------|----------------|
| `packages/pangolin-core/src/audit.ts` | modify | `Authorization`/`AuthorizationContext`/`AuthorizationVerdict`/`Authorizer`/`AuthzTier` types; `authorization?` on `DispatchManifest` + `AuditEntry`; `item.denied` in `AuditEntryKind`; `authzTier?` + `'manifest'` failure on `VerificationReport` |
| `packages/pangolin-core/src/audit-canon.ts` | modify | conditional-push the sealed `authorization` into `canonEntry` (only when present → existing entries byte-identical) |
| `packages/pangolin-core/src/audit-verify-bundle.ts` | modify | manifest-integrity check (Finding A) + `authzTier` derivation |
| `packages/pangolin-orchestrator/src/audit/authorizer.ts` | create | `NoneAuthorizer` + `createConfigAuthorizer` (in-tree, no external dep) |
| `packages/pangolin-orchestrator/src/contracts/executor.ts` | modify | `FireContext` gains `effectClass?` + `authorization?` |
| `packages/pangolin-orchestrator/src/audit/manifest.ts` | modify | `BuildManifestInput` + manifest base gain `authorization?` |
| `packages/pangolin-orchestrator/src/executors/dispatch.ts` | modify | pass `ctx.authorization` into `buildManifest` |
| `packages/pangolin-orchestrator/src/engine/tick.ts` | modify | the fire gate (before `ex.fire()`): allow→thread decision; deny→`denied` + `item.denied` |
| `packages/pangolin-orchestrator/src/engine/dep-resolver.ts` | modify | `computeSkipped` treats `denied` as a skip-trigger |
| `packages/pangolin-orchestrator/src/orchestrator.ts` | modify | inject `Authorizer`; submit pre-check; add `denied` to `TERMINAL_STATUSES`; thread authorizer into `tick` |
| `docs-site/.../reference/*` (verify-print honesty line) | modify | reflect `authzTier` (attests a recorded dispatch-level decision; still not mid-run governance) |

> **Type names (use verbatim everywhere):** `AuthorizationVerdict = 'allow' | 'deny' | 'not-evaluated'`; `Authorization` (the decision AND the sealed block — one DRY type); `AuthorizationContext`; `Authorizer`; `AuthzTier = 'none' | 'recorded' | 'authority-attested'`; item status string `'denied'`; report `failure` adds `'manifest'`.

---

## Wave A — Core type surface (additive)

### Task 1: Authorization types + manifest/entry/report fields

**Files:**
- Modify: `packages/pangolin-core/src/audit.ts`
- Test: `packages/pangolin-core/test/authorization-types.test.ts` (create)

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  Authorization, AuthorizationContext, Authorizer, AuthorizationVerdict,
  AuthzTier, DispatchManifest, AuditEntry, AuditEntryKind, VerificationReport,
} from '../src/audit.js';

describe('authorization type surface', () => {
  it('Authorization has the sealed-evidence shape', () => {
    const a: Authorization = { verdict: 'allow', principal: 'op:policy', policyRef: 'sha256:x', effectClass: 'pure', at: '2026-06-16T00:00:00Z' };
    expect(a.verdict).toBe('allow');
  });
  it('manifest + entry carry optional authorization; item.denied is a kind', () => {
    const k: AuditEntryKind = 'item.denied';
    expect(k).toBe('item.denied');
    expectTypeOf<DispatchManifest['authorization']>().toEqualTypeOf<Authorization | undefined>();
    expectTypeOf<AuditEntry['authorization']>().toEqualTypeOf<Authorization | undefined>();
  });
  it('report gains optional authzTier and a manifest failure variant', () => {
    const t: AuthzTier = 'recorded';
    expect(t).toBe('recorded');
    expectTypeOf<VerificationReport['authzTier']>().toEqualTypeOf<AuthzTier | undefined>();
    const f: NonNullable<VerificationReport['failure']> = 'manifest';
    expect(f).toBe('manifest');
  });
  it('Authorizer is an async (ctx) => Authorization', () => {
    const _a: Authorizer = { async authorize(_c: AuthorizationContext) { return { verdict: 'not-evaluated' as AuthorizationVerdict, principal: 'none', policyRef: 'none', effectClass: 'pure', at: '' }; } };
    expect(typeof _a.authorize).toBe('function');
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @quarry-systems/pangolin-core test -- authorization-types` → FAIL (types missing).

- [ ] **Step 3: Implement** — in `packages/pangolin-core/src/audit.ts`:
  - Add the types (near the existing `Signer`/`Signature` block):
```ts
export type AuthorizationVerdict = 'allow' | 'deny' | 'not-evaluated';

/** The authorization decision AND the sealed evidence block (one shape). All string/ref
 *  fields — no values. `policyRef` is a content-hash of the deciding ruleset. */
export interface Authorization {
  verdict: AuthorizationVerdict;
  principal: string;        // the authority that decided
  onBehalfOf?: string;      // delegation principal the work serves
  policyRef: string;        // sha256:… of the deciding policy/ruleset (or 'none')
  effectClass: string;      // the sealed effect class (folds in invariant #4)
  reason?: string;          // human-readable; BUNDLE-VISIBLE — no secrets/PII
  at: string;               // ISO-8601 decision time
}

export interface AuthorizationContext {
  phase: 'submit' | 'fire';
  actor: string;
  shapeId: string;
  effectClass: string;
  onBehalfOf?: string;
  inputRefs?: Record<string, string>;  // resolved at fire; absent at submit
  submittedAt?: string;
}

export interface Authorizer { authorize(ctx: AuthorizationContext): Promise<Authorization>; }

/** Authorization assurance dimension — orthogonal to intact/claim (cf. TimeTier). */
export type AuthzTier = 'none' | 'recorded' | 'authority-attested';
```
  - Add `authorization?: Authorization;` to `interface DispatchManifest` (after `signature?`).
  - Add `authorization?: Authorization;` to `interface AuditEntry` (after `at`).
  - Add `'item.denied'` to the `AuditEntryKind` union.
  - On `VerificationReport`: add `authzTier?: AuthzTier;` and add `'manifest'` to the `failure?:` union.

- [ ] **Step 4: Run, verify PASS** — `pnpm --filter @quarry-systems/pangolin-core test -- authorization-types` → PASS. Also `pnpm --filter @quarry-systems/pangolin-core typecheck` → clean.

- [ ] **Step 5: Commit**
```bash
git add packages/pangolin-core/src/audit.ts packages/pangolin-core/test/authorization-types.test.ts
git commit -m "feat(core): authorization type surface (Authorization/Authorizer/authzTier/item.denied)"
```

> Context: `Authorization` is intentionally one type for both the `authorize()` return and the sealed block (DRY). `effectClass` is a string (the orchestrator's `EffectTier` is `pure|read-impure|write-impure`, passed through as a string at the core boundary so core stays orchestrator-agnostic).

---

### Task 2: `canonEntry` seals `authorization` (append-only, existing entries unchanged)

**Files:**
- Modify: `packages/pangolin-core/src/audit-canon.ts`
- Test: `packages/pangolin-core/test/audit-canon-authorization.test.ts` (create)

> `canonEntry` is a 9-element positional array. Appending a 10th element unconditionally would change EVERY existing entry's canonical bytes (`[…,seq]` → `[…,seq,null]`) and break all chains/vectors. So push the authorization element ONLY when present — existing entries serialize byte-identically.

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect } from 'vitest';
import { canonEntry } from '../src/audit-canon.js';
import type { AuditEntry, Authorization } from '../src/audit.js';

const base: AuditEntry = { runId: 'r', seq: 3, kind: 'item.fired', itemId: 'a', at: 't' };

describe('canonEntry authorization', () => {
  it('an entry WITHOUT authorization is byte-identical to the legacy 9-field form', () => {
    expect(canonEntry(base)).toBe(JSON.stringify(['item.fired','r','a',null,null,null,null,'t',3]));
  });
  it('an item.denied entry WITH authorization appends a 10th (canonicalized) element', () => {
    const authz: Authorization = { verdict: 'deny', principal: 'op:policy', policyRef: 'sha256:p', effectClass: 'write-impure', reason: 'blocked', at: 't2' };
    const denied: AuditEntry = { ...base, kind: 'item.denied', authorization: authz };
    const s = canonEntry(denied);
    expect(s).not.toBe(canonEntry({ ...denied, authorization: undefined })); // presence changes the bytes
    expect(JSON.parse(s).length).toBe(10);
  });
  it('the appended element is stable under key reordering (canonicalized)', () => {
    const a1: Authorization = { verdict: 'deny', principal: 'p', policyRef: 'r', effectClass: 'pure', at: 't' };
    const a2: Authorization = { at: 't', effectClass: 'pure', policyRef: 'r', principal: 'p', verdict: 'deny' } as Authorization;
    expect(canonEntry({ ...base, authorization: a1 })).toBe(canonEntry({ ...base, authorization: a2 }));
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @quarry-systems/pangolin-core test -- audit-canon-authorization` → FAIL.

- [ ] **Step 3: Implement** — rewrite `canonEntry` in `audit-canon.ts`:
```ts
import type { AuditEntry } from './audit.js';
import { canonicalJsonString } from './canonical-json.js';   // sorted-key canonicalizer (already in core)

/** Positional JSON array — Pangolin Scale's pinned field order. Absent optionals → null.
 *  [kind, runId, itemId, status, actor, manifestRef, resultRef, at, seq] (+ canonicalized
 *  authorization as a trailing 10th element ONLY when present, so legacy entries are unchanged). */
export function canonEntry(e: AuditEntry): string {
  const arr: unknown[] = [
    e.kind, e.runId, e.itemId ?? null, e.status ?? null, e.actor ?? null,
    e.manifestRef ?? null, e.resultRef ?? null, e.at, e.seq,
  ];
  if (e.authorization !== undefined) arr.push(canonicalJsonString(e.authorization));
  return JSON.stringify(arr);
}
```
> Verify the exact import path/name of core's sorted-key canonicalizer (`canonicalJsonString` is used in `audit/manifest.ts` via the core barrel) and use it so the appended element is key-order-stable.

- [ ] **Step 4: Run, verify PASS** — targeted test PASS; then `pnpm --filter @quarry-systems/pangolin-core test` (the whole core suite — confirms no existing entry-hash/vector test regresses, since absent-authorization entries are byte-identical).

- [ ] **Step 5: Commit**
```bash
git add packages/pangolin-core/src/audit-canon.ts packages/pangolin-core/test/audit-canon-authorization.test.ts
git commit -m "feat(core): seal authorization into canonEntry (append-only; legacy entries byte-identical)"
```

---

## Wave B — Manifest-integrity check (Finding A — prerequisite for trustworthy evidence)

### Task 3: `verifyBundle` recomputes manifest hashes vs the chained `manifestRef`

**Files:**
- Modify: `packages/pangolin-core/src/audit-verify-bundle.ts`
- Test: `packages/pangolin-core/test/verify-bundle-manifest-integrity.test.ts` (create)

> Today `verifyBundle` reads `bundle.manifests` only for handoff closure — nothing re-derives a manifest's content hash and compares it to the `manifestRef` sealed in its `item.fired` entry. So a mutated manifest field (incl. the new `authorization`) goes undetected. Close it: recompute each manifest's content address and compare to the chained ref.

- [ ] **Step 1: Write the failing test** (build a minimal bundle whose manifest content-hash matches the chained `item.fired` manifestRef; then mutate a manifest field and assert verify fails)
```ts
import { describe, it, expect } from 'vitest';
import { verifyBundle } from '../src/audit-verify-bundle.js';
import { manifestContentRef } from '../src/audit-verify-bundle.js';  // exported helper added in Step 3
import type { AuditBundle, DispatchManifest } from '../src/audit.js';
// Helper: assemble a one-item bundle from a manifest so manifestRef == manifestContentRef(manifest).
// (Use the test factory in packages/pangolin-core/test/support if present; else inline an offline anchor
//  + a single item.fired entry whose manifestRef = manifestContentRef(manifest), and a matching root.)

function bundleWith(manifest: DispatchManifest): AuditBundle { /* see support/make-bundle */ return /* … */ ({} as AuditBundle); }

describe('manifest integrity (Finding A)', () => {
  it('a bundle whose manifest matches its chained manifestRef verifies intact', async () => {
    const m: DispatchManifest = /* a valid manifest */ ({} as DispatchManifest);
    const report = await verifyBundle(bundleWith(m), { anchor: /* offline */ undefined as never });
    expect(report.intact).toBe(true);
  });
  it('mutating a sealed manifest field (authorization verdict) makes verify NOT intact', async () => {
    const m: DispatchManifest = /* valid, authorization.verdict = "deny" */ ({} as DispatchManifest);
    const b = bundleWith(m);
    (b.manifests[0]!.authorization as { verdict: string }).verdict = 'allow';  // forge deny→allow
    const report = await verifyBundle(b, { anchor: undefined as never });
    expect(report.intact).toBe(false);
    expect(report.failure).toBe('manifest');
  });
});
```
> Build the bundle with the repo's existing audit test helpers (grep `test/support` / `make-bundle` / how `verify-bundle.test.ts` and `tamper-evident-contrast.test.ts` assemble bundles) so `manifestRef` is the genuine content address. The implementer wires the factory; the assertions are the contract.

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @quarry-systems/pangolin-core test -- verify-bundle-manifest-integrity` → the mutation test FAILS (verify currently reports intact).

- [ ] **Step 3: Implement** — in `audit-verify-bundle.ts`:
  - Export `manifestContentRef(m: DispatchManifest): string` — recompute the manifest's content address **the same way the dispatch executor does** when it returns `manifestRef`. (Locate that in `packages/pangolin-orchestrator/src/executors/dispatch.ts`; it content-addresses the bytes from `buildManifest`, which excludes nothing — it hashes the full manifest including `manifestHash`. Match it EXACTLY, or the comparison is meaningless. If it hashes the canonical manifest bytes, reuse the same `computeContentHash`/content-address fn from core.)
  - In `verifyBundle`, after the base verify: for each `m` of `bundle.manifests`, find its `item.fired` entry (by `itemId`) and its sealed `manifestRef`; if `manifestRef` is present and `manifestContentRef(m) !== manifestRef`, set `manifestOk = false`.
  - Fold into the result: `const intact = base.intact && handoff.ok !== false && manifestOk;` and `failure = base.failure ?? (manifestOk === false ? 'manifest' : handoff.ok === false ? 'handoff' : undefined);` (do NOT add a key to `checks` — that object's shape is load-bearing for consumer literals; `failure:'manifest'` + `intact:false` is the surfacing).

- [ ] **Step 4: Run, verify PASS** — targeted test PASS; full core suite green.

- [ ] **Step 5: Commit**
```bash
git add packages/pangolin-core/src/audit-verify-bundle.ts packages/pangolin-core/test/verify-bundle-manifest-integrity.test.ts
git commit -m "fix(verify): manifest-integrity check — recomputed manifest hash must equal the chained manifestRef (Finding A)"
```

---

## Wave C — Authorizer implementations (orchestrator, no external dep)

### Task 4: `NoneAuthorizer` + `createConfigAuthorizer`

**Files:**
- Create: `packages/pangolin-orchestrator/src/audit/authorizer.ts`
- Test: `packages/pangolin-orchestrator/test/audit/authorizer.test.ts` (create)

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect } from 'vitest';
import { NoneAuthorizer, createConfigAuthorizer } from '../../src/audit/authorizer.js';
import type { AuthorizationContext } from '@quarry-systems/pangolin-core';

const ctx = (over: Partial<AuthorizationContext> = {}): AuthorizationContext =>
  ({ phase: 'fire', actor: 'agent:x', shapeId: 'dev.code-edit', effectClass: 'write-impure', at: '', ...over } as AuthorizationContext);

describe('NoneAuthorizer', () => {
  it('never blocks; verdict not-evaluated; echoes effectClass', async () => {
    const d = await NoneAuthorizer.authorize(ctx());
    expect(d.verdict).toBe('not-evaluated');
    expect(d.principal).toBe('none');
    expect(d.policyRef).toBe('none');
    expect(d.effectClass).toBe('write-impure');
  });
});

describe('createConfigAuthorizer', () => {
  const authz = createConfigAuthorizer({
    principal: 'op:acme', policyRef: 'sha256:rules',
    rules: [{ deny: { effectClass: 'write-impure', actor: 'agent:untrusted' }, reason: 'untrusted may not write' }],
  });
  it('denies a matching rule with a generic-safe reason + the matched effectClass', async () => {
    const d = await authz.authorize(ctx({ actor: 'agent:untrusted' }));
    expect(d.verdict).toBe('deny');
    expect(d.effectClass).toBe('write-impure');
    expect(d.reason).toMatch(/untrusted/);
  });
  it('allows when no rule matches', async () => {
    expect((await authz.authorize(ctx({ actor: 'agent:trusted' }))).verdict).toBe('allow');
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @quarry-systems/pangolin-orchestrator test -- audit/authorizer` → FAIL.

- [ ] **Step 3: Implement** — `packages/pangolin-orchestrator/src/audit/authorizer.ts`:
```ts
import type { Authorizer, Authorization, AuthorizationContext } from '@quarry-systems/pangolin-core';

/** Default — allow-all, records nothing meaningful. Mirrors NoneSigner. Keeps demo/dev unchanged. */
export const NoneAuthorizer: Authorizer = {
  async authorize(ctx: AuthorizationContext): Promise<Authorization> {
    return { verdict: 'not-evaluated', principal: 'none', policyRef: 'none', effectClass: ctx.effectClass, at: ctx.at ?? '' };
  },
};

export interface ConfigRule { deny: { effectClass?: string; actor?: string; shapeId?: string }; reason?: string; }
export interface ConfigAuthorizerOpts { principal: string; policyRef: string; rules: ConfigRule[]; }

/** In-tree, dependency-free authorizer: deny if any rule's stated fields all match; else allow.
 *  effectClass in the decision is ALWAYS the ctx (shape-derived) value — never caller inputs. */
export function createConfigAuthorizer(opts: ConfigAuthorizerOpts): Authorizer {
  return {
    async authorize(ctx: AuthorizationContext): Promise<Authorization> {
      const at = ctx.at ?? new Date(0).toISOString();   // caller supplies the real time; deterministic fallback
      for (const r of opts.rules) {
        const m = r.deny;
        const hit = (m.effectClass === undefined || m.effectClass === ctx.effectClass)
          && (m.actor === undefined || m.actor === ctx.actor)
          && (m.shapeId === undefined || m.shapeId === ctx.shapeId);
        if (hit) return { verdict: 'deny', principal: opts.principal, policyRef: opts.policyRef, effectClass: ctx.effectClass, onBehalfOf: ctx.onBehalfOf, reason: r.reason, at };
      }
      return { verdict: 'allow', principal: opts.principal, policyRef: opts.policyRef, effectClass: ctx.effectClass, onBehalfOf: ctx.onBehalfOf, at };
    },
  };
}
```
> Note `at` is taken from the context (the caller stamps decision time) to keep the authorizer pure/deterministic for tests; do NOT call `Date.now()` inside — the caller (tick/submit) passes `at`.

- [ ] **Step 4: Run, verify PASS**; export both from the orchestrator barrel `src/index.ts` (beside `NoneSigner`/`createLocalSigner`) and extend `test/barrel-audit-surface.test.ts` to assert they're exposed.

- [ ] **Step 5: Commit**
```bash
git add packages/pangolin-orchestrator/src/audit/authorizer.ts packages/pangolin-orchestrator/src/index.ts packages/pangolin-orchestrator/test/audit/authorizer.test.ts packages/pangolin-orchestrator/test/barrel-audit-surface.test.ts
git commit -m "feat(orchestrator): NoneAuthorizer + in-tree config authorizer (no external dep)"
```

---

## Wave D — Wiring (manifest seal + the two gates + denied terminal state)

### Task 5: `FireContext` + `buildManifest` carry the decision; the executor seals it

**Files:**
- Modify: `packages/pangolin-orchestrator/src/contracts/executor.ts` (`FireContext`)
- Modify: `packages/pangolin-orchestrator/src/audit/manifest.ts` (`BuildManifestInput` + base)
- Modify: `packages/pangolin-orchestrator/src/executors/dispatch.ts` (pass `ctx.authorization` to `buildManifest`)
- Test: `packages/pangolin-orchestrator/test/audit/manifest.test.ts` (extend)

- [ ] **Step 1: Write the failing test** (extend manifest.test.ts)
```ts
import type { Authorization } from '@quarry-systems/pangolin-core';
it('buildManifest seals an authorization block + it is covered by manifestHash', () => {
  const authz: Authorization = { verdict: 'allow', principal: 'op:acme', policyRef: 'sha256:r', effectClass: 'pure', at: 't' };
  const a = buildManifest({ runId: 'r', itemId: 'i', executor: 'dispatch', executorManifest: {}, secretRefs: [], actor: 'agent:x', firedAt: 't', authorization: authz });
  expect(a.manifest.authorization).toEqual(authz);
  const b = buildManifest({ runId: 'r', itemId: 'i', executor: 'dispatch', executorManifest: {}, secretRefs: [], actor: 'agent:x', firedAt: 't' });
  expect(a.manifest.manifestHash).not.toBe(b.manifest.manifestHash);   // authorization perturbs the self-hash
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @quarry-systems/pangolin-orchestrator test -- audit/manifest` → FAIL (authorization not accepted/sealed).

- [ ] **Step 3: Implement**
  - `executor.ts` `FireContext`: add `effectClass?: string;` and `authorization?: import('@quarry-systems/pangolin-core').Authorization;`.
  - `manifest.ts`: add `authorization?: Authorization;` to `BuildManifestInput`, and `authorization: input.authorization,` into `base` (so `computeContentHash` covers it; absent → dropped, existing hashes unchanged).
  - `dispatch.ts`: where it calls `buildManifest({...})`, pass `authorization: ctx?.authorization`.

- [ ] **Step 4: Run, verify PASS** (manifest suite + dispatch executor tests green).

- [ ] **Step 5: Commit**
```bash
git add packages/pangolin-orchestrator/src/contracts/executor.ts packages/pangolin-orchestrator/src/audit/manifest.ts packages/pangolin-orchestrator/src/executors/dispatch.ts packages/pangolin-orchestrator/test/audit/manifest.test.ts
git commit -m "feat(orchestrator): thread authorization through FireContext → buildManifest (sealed in the manifest)"
```

---

### Task 6: `denied` terminal status + cascade

**Files:**
- Modify: `packages/pangolin-orchestrator/src/orchestrator.ts:40` (`TERMINAL_STATUSES`)
- Modify: `packages/pangolin-orchestrator/src/engine/dep-resolver.ts:46-59` (`computeSkipped`)
- Test: `packages/pangolin-orchestrator/test/engine/dep-resolver.test.ts` (extend or create)

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect } from 'vitest';
import { computeSkipped } from '../../src/engine/dep-resolver.js';
import type { ItemState } from '../../src/contracts/index.js';
const item = (over: Partial<ItemState>): ItemState => ({ id: 'x', status: 'pending', depends_on: [], needs: {}, /* …minimal */ ...over } as ItemState);
it('a pending item whose dependency is denied cascades to skipped', () => {
  const items = [item({ id: 'g', status: 'denied' as ItemState['status'] }), item({ id: 'c', depends_on: ['g'] })];
  expect(computeSkipped(items)).toContain('c');
});
```

- [ ] **Step 2: Run, verify FAIL** — denied dep does not yet trigger skip.

- [ ] **Step 3: Implement**
  - `orchestrator.ts:40`: `const TERMINAL_STATUSES = new Set(['done', 'failed', 'skipped', 'cancelled', 'denied']);`
  - `dep-resolver.ts` `computeSkipped` (line ~55): add `denied` to the trigger — `return s === 'failed' || s === 'skipped' || s === 'cancelled' || s === 'denied' || isBlockedBy(i, dep);`
  - Confirm `ItemState['status']` admits `'denied'` (if it's a string union, add it; if `string`, no change).

- [ ] **Step 4: Run, verify PASS** (dep-resolver + orchestrator suites green — esp. any "run seals when all terminal" test still holds with `denied` terminal).

- [ ] **Step 5: Commit**
```bash
git add packages/pangolin-orchestrator/src/orchestrator.ts packages/pangolin-orchestrator/src/engine/dep-resolver.ts packages/pangolin-orchestrator/test/engine/dep-resolver.test.ts
git commit -m "feat(engine): denied is terminal + cascades skip to dependents (run still seals)"
```

---

### Task 7: the fire gate in `tick.ts` (before `ex.fire()`)

**Files:**
- Modify: `packages/pangolin-orchestrator/src/engine/tick.ts` (the fire loop ~87-134; `tick` signature to receive the authorizer + `auditAt`)
- Test: `packages/pangolin-orchestrator/test/audit/engine-wiring.test.ts` (extend) or a focused `test/engine/fire-gate.test.ts`

> The gate runs after shape resolution (the `void effectTierPolicy(shape.effectTier)` line — the `TODO(PR6)` marker) and BEFORE `acquireLocks`/`ex.fire()`. `effectClass = shape.effectTier`. allow → thread the decision into `ex.fire(fireItem, { …, effectClass, authorization })`. deny → `store.setStatus(it.id, 'denied', reason)`, `releaseLocks`, emit an `item.denied` audit entry carrying the decision, `continue` (do not fire).

- [ ] **Step 1: Write the failing test** — a tick with an injected authorizer that denies a `write-impure` item asserts: the item ends `denied`, the executor's `fire` was NOT called for it, and an `item.denied` audit entry with the decision was emitted (carrying `authorization`). A second item (allowed) fires and its manifest carries the `allow` authorization. (Model on the existing `engine-wiring.test.ts` harness: a fake executor recording `fire` calls + a capturing `audit` fn.)

- [ ] **Step 2: Run, verify FAIL**.

- [ ] **Step 3: Implement** — thread an `authorizer: Authorizer` (default `NoneAuthorizer`) into `tick`'s deps; in the fire loop, right after the `effectTierPolicy` line, for items with a resolved `shape`:
```ts
const effectClass = shape.effectTier;
const decision = await authorizer.authorize({
  phase: 'fire', actor: it.actor, shapeId: shape.id, effectClass,
  onBehalfOf: (it.inputs as { onBehalfOf?: string } | undefined)?.onBehalfOf,
  inputRefs: (fireItem.inputs as { inputRefs?: Record<string,string> } | undefined)?.inputRefs,
  submittedAt: it.submittedAt, at: auditAt,
});
if (decision.verdict === 'deny') {
  store.setStatus(it.id, 'denied', decision.reason ?? 'authorization denied');
  store.releaseLocks(it.id);
  audit({ kind: 'item.denied', runId: it.runId, itemId: deNs(it.id), status: 'denied', actor: it.actor, at: auditAt, authorization: decision });
  continue;
}
// allow / not-evaluated → carry the decision to fire so it is sealed in the manifest:
fireItem = { ...fireItem, __authorization: decision } as typeof fireItem; // see note
```
Then at `ex.fire(...)` (line ~123) pass `{ runId, actor, submittedAt, effectClass, authorization: decision }`. (Locks: only `acquireLocks` AFTER an allow — a denied item must release any locks; in the current code locks are acquired at line 115 *after* shape resolution, so place the gate before line 115 and only `acquireLocks` on allow.)
> Items with **no `subagentShape`** (raw executor items) have no `shape.effectTier` — give them a default effectClass `'unknown'` and still call `authorize` (so policy can govern them), or skip the gate per a documented default. Pick: default `effectClass='unknown'`, gate runs. State this in the test.

- [ ] **Step 4: Run, verify PASS**; run the full orchestrator suite (the fire loop is hot — `NoneAuthorizer` default must leave every existing test green).

- [ ] **Step 5: Commit**
```bash
git add packages/pangolin-orchestrator/src/engine/tick.ts packages/pangolin-orchestrator/test/...
git commit -m "feat(engine): fire-time authorization gate before ex.fire() — allow seals, deny blocks + seals item.denied"
```

---

### Task 8: orchestrator injection + submit pre-check

**Files:**
- Modify: `packages/pangolin-orchestrator/src/orchestrator.ts` (`PangolinOrchestratorOptions`, ctor, `submitRun`, the `tick` call site)
- Test: `packages/pangolin-orchestrator/test/orchestrator.test.ts` (extend)

- [ ] **Step 1: Write the failing tests** — (a) `submitRun` with an authorizer that denies a write-impure item throws/rejects with a **generic** message ("submission denied by policy") and nothing is queued (store has no run); (b) with `NoneAuthorizer` (default, none supplied) submit + tick behave exactly as today; (c) the authorizer is passed into `tick`.

- [ ] **Step 2: Run, verify FAIL**.

- [ ] **Step 3: Implement**
  - `PangolinOrchestratorOptions`: add `authorizer?: Authorizer;`. Ctor: `this.authorizer = opts.authorizer ?? NoneAuthorizer;`.
  - In `submitRun`, after `validateRun`, for each item resolve its shape from `this.packs` (mirror `run-validator`), derive `effectClass = shape?.effectTier ?? 'unknown'`, call `this.authorizer.authorize({ phase:'submit', actor, shapeId: item.subagentShape ?? '', effectClass, onBehalfOf, submittedAt, at })`; if `verdict==='deny'` throw `new Error('submission denied by policy')` (generic — do NOT echo the rule) **before** `saveRun`.
  - Pass `authorizer: this.authorizer` into the `tick(...)` deps.

- [ ] **Step 4: Run, verify PASS** (orchestrator suite green; the default-NoneAuthorizer path unchanged).

- [ ] **Step 5: Commit**
```bash
git add packages/pangolin-orchestrator/src/orchestrator.ts packages/pangolin-orchestrator/test/orchestrator.test.ts
git commit -m "feat(orchestrator): inject Authorizer + submit-time fail-fast pre-check (generic deny error)"
```

---

## Wave E — Verify dimension + honesty

### Task 9: `authzTier` derivation in `verifyBundle`

**Files:**
- Modify: `packages/pangolin-core/src/audit-verify-bundle.ts`
- Test: `packages/pangolin-core/test/verify-bundle-authztier.test.ts` (create)

- [ ] **Step 1: Write the failing test** — three bundles: (a) all manifests `authorization` absent / `verdict:'not-evaluated'` → `authzTier:'none'`; (b) at least one sealed `allow`/`deny` (`verdict` ∈ {allow,deny}) in a manifest or an `item.denied` entry → `authzTier:'recorded'`; (c) `authzTier` never changes `intact`/`claim` (a tamper-evident bundle reports the same `claim` regardless of authzTier).

- [ ] **Step 2: Run, verify FAIL**.

- [ ] **Step 3: Implement** — in `verifyBundle`, after computing `intact`/`claim`, derive:
```ts
const decided = bundle.manifests.some((m) => m.authorization && m.authorization.verdict !== 'not-evaluated')
  || bundle.auditLog.entries.some((e) => e.kind === 'item.denied' && e.authorization?.verdict === 'deny');
const authzTier: AuthzTier = decided ? 'recorded' : 'none';
return { ...base, intact, failure, claim, authzTier, checks: { ...base.checks, handoff } };
```
(`authority-attested` is reserved — never produced in this build.) `authzTier` is computed independently of `intact`/`claim`/`failure`.

- [ ] **Step 4: Run, verify PASS**; full core suite green.

- [ ] **Step 5: Commit**
```bash
git add packages/pangolin-core/src/audit-verify-bundle.ts packages/pangolin-core/test/verify-bundle-authztier.test.ts
git commit -m "feat(verify): derive orthogonal authzTier (none|recorded) from sealed authorization"
```

---

### Task 10: surface `authzTier` in `agora verify` print + honesty line

**Files:**
- Modify: the verify renderer (`packages/pangolin-verify/src/render.ts` or the `agora verify` print path — locate via `renderVerification`) + the docs honesty line
- Test: the renderer test (extend)

- [ ] **Step 1: Write the failing test** — `renderVerification` of a report with `authzTier:'recorded'` includes a line naming authorization as a **recorded, operator-self-asserted dispatch-level** decision (not third-party attested); `authzTier:'none'` prints "authorization: not attested".

- [ ] **Step 2: Run, verify FAIL**.

- [ ] **Step 3: Implement** — add the `authzTier` line to the renderer (a separate line from the tamper claim + timeTier). Keep the self-asserted qualifier. Update the docs-site reference/verify-print copy: it now attests a *recorded dispatch-level* authorization decision; it still does **not** govern the agent's individual tool calls (mid-run).

- [ ] **Step 4: Run, verify PASS**; docs build if the docs page changed (`pnpm --filter @pangolin/docs-site build`).

- [ ] **Step 5: Commit**
```bash
git add packages/pangolin-verify/src/render.ts docs-site/... packages/pangolin-verify/test/...
git commit -m "feat(verify): print authzTier as a separate self-asserted line; update honesty copy"
```

---

## Wave F — Conformance vectors + integration

### Task 11: regenerate audit conformance vectors + an end-to-end allow/deny seal test

**Files:**
- Modify: `packages/pangolin-orchestrator/test/conformance/audit-vectors/*.json` (only those whose entries/manifests now legitimately carry authorization; legacy no-authorization vectors are byte-identical and must NOT change)
- Test: `packages/pangolin-orchestrator/test/audit/acceptance.int.test.ts` (extend) or a focused integration test

- [ ] **Step 1: Write the integration test** — run a small real run through the orchestrator with `createConfigAuthorizer` (one allow item, one deny item, one dependent of the denied item): assert the allowed item's manifest seals `authorization.verdict==='allow'`; the denied item is `denied` with a sealed `item.denied` entry; the dependent cascades to `skipped`; the run **seals**; and a full `verifyBundle` of the export reports `intact:true`, `authzTier:'recorded'`, and (negative) mutating the sealed `authorization` flips `intact:false`/`failure:'manifest'`.

- [ ] **Step 2: Run** — fix any conformance vector whose hashes legitimately changed by **regenerating to the new honest values** (never by loosening an assertion). Confirm legacy no-authorization vectors are untouched.

- [ ] **Step 3: Commit**
```bash
git add packages/pangolin-orchestrator/test/...
git commit -m "test(seal): e2e allow/deny authorization seal + regenerate affected conformance vectors"
```

---

## Final task: full gate

- [ ] **Step 1:** `pnpm install && pnpm -r build` (fresh-worktree, stale-dist guard).
- [ ] **Step 2:** the full gate — `pnpm -r typecheck` && `pnpm -r test` && `pnpm test:e2e` (separate CI job) && `pnpm -r lint`. Fix any stale `VerificationReport`/manifest literal by satisfying the new shape (the additions are optional → expect few), never by loosening a security assertion. Run `pnpm run check:deps` — `pangolin-core`/orchestrator must import no policy-engine package.
- [ ] **Step 3:** Confirm acceptance #1–9 from the spec each map to a green test (esp. #2 manifest-integrity negative test, #3 run-seals-on-deny + cascade, #6 effectClass-from-shape).
- [ ] **Step 4:** Final commit if fixtures changed.

---

## Self-review notes (spec coverage)

- Spec §4 types/seam → Tasks 1, 4. §5 gates → Tasks 7 (fire), 8 (submit). §6 sealing + Finding A → Tasks 1, 2, 3, 5. §7 authzTier → Tasks 1, 9, 10. §8 honesty → Task 10. §3.1 corrections all mapped: Finding A → Task 3; injection (two sites) → Tasks 7, 8; denied→TERMINAL_STATUSES/computeSkipped → Task 6; gate-before-fire → Task 7; FireContext.effectClass + AuditEntry/canon field → Tasks 5, 2; effectClass-from-shape → Tasks 4, 7; dep-guard not over-claimed → Final §2; reason bound/bundle-visible → Tasks 1, 4 (documented). §10 blast radius / §12 acceptance → Final task.
- Type consistency: `Authorization` (one type for decision + sealed block), `AuthorizationContext`, `Authorizer`, `AuthorizationVerdict`, `AuthzTier`, status `'denied'`, `failure:'manifest'`, `NoneAuthorizer`, `createConfigAuthorizer` — used identically across tasks.
- No `checks` key added to `VerificationReport` (manifest integrity surfaces via `failure:'manifest'`); `authzTier`/`authorization` are optional → consumer literals don't break.
- The single delicate spot (canonEntry length change) is handled by conditional-push (Task 2) so legacy entries/vectors stay byte-identical.
