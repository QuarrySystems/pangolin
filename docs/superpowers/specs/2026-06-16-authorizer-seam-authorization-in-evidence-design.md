# Authorizer seam + authorization-in-evidence — design

- **Status:** draft (design approved in brainstorming 2026-06-16; the 4 scope forks below are settled)
- **Date:** 2026-06-16
- **Consolidates / refines:** `wikis/agora/synthesis/synthesis-authorizer-authorization-in-evidence.md`
- **Requirement home:** `decision-2026-06-04-seal-must-meet-soc2-hipaa-eu-ai-act-iso` (compliance item **#2, authorization-in-evidence**) + `decision-2026-06-03-pack-architecture-invariants-ship-only` (**invariant #4, effect class in evidence**)
- **Pattern precedent:** the `Signer` seam + its production custody story (PR #73, `decision-2026-06-15-seal-signing-key-custody-demo-local`)
- **Assurance precedent:** trusted-time as a separate dimension (PR #66, `timeTier`); `decision-2026-06-09-evidence-assurance-is-two-dimensional`

---

## 1. Problem

The seal proves **ran → produced** but not **authorized** — the "and that it was allowed to" half of the GTM hook. Two concrete gaps, both grounded in code:

- **`actor` is identity, not authorization.** `DispatchManifest.actor` (`packages/pangolin-core/src/audit.ts`) is a `human:<id>`/`agent:<id>` stamp; nothing records *that the action was authorized*, *by whom/under what policy*, or *on whose behalf*. The threat-model page states this plainly ("`actor` is identity, not authz").
- **Effect class is computed then discarded.** `SubagentShape.effectTier` (`packages/pangolin-orchestrator/src/contracts/subagent-shape.ts`) is derived per dispatch by the effect policy (`contracts/effect-policy.ts`, applied in `engine/tick.ts`) and **never sealed** into the manifest (pack invariant #4).

This is seal-compliance **#2**, demand-pulled — now being built. It maps to ISO 42001's "every action → authenticated role," EU AI Act Art 12, and SOC 2 CC6.

## 2. Decisions resolved in brainstorming (2026-06-16)

| # | Fork | Resolution |
|---|------|-----------|
| 1 | What does it do? | **Dispatch-level `Authorizer`: allow/deny, fail-closed, seals the decision either way.** Bounded to the dispatch boundary. **NOT** mid-run interception of the agent's individual tool calls (that remains the threat-model's deferred "fine-grained action-denial" non-goal). |
| 2 | Where is the gate? | **Both** — a cheap **submit-time pre-check** (fail-fast, never queues unauthorized work) **and** the **binding decision at fire** (sealed into the manifest; authoritative). |
| 3 | Verify treatment | A **separate `authzTier` dimension**, orthogonal to `intact`/`claim` — exactly how `timeTier` was added. Authorization never silently weakens the tamper claim. |
| 4 | Seam + packaging | **Mirror the `Signer` seam.** Interface in `pangolin-core`; default + a simple in-tree config authorizer in the orchestrator; external **policy-engine adapters as future `pangolin-authorizer-<engine>` leaf packages**, integrator-wired, demand-pulled **per engine** (do **not** pre-pick Cedar/OPA/Cerbos). |

## 3. Current-state grounding (verified at the module level; the plan/audit pins exact lines)

| Fact | Location |
|------|----------|
| `Signer` interface lives in core (dependency-light); `NoneSigner`/`createLocalSigner` (defaults/local) live in the orchestrator; production adapter is a leaf (`pangolin-signer-aws-kms`); orchestrator injects it. **This is the pattern to mirror.** | `packages/pangolin-core/src/audit.ts` (interface); `packages/pangolin-orchestrator/src/audit/signer.ts`; `packages/pangolin-signer-aws-kms/` |
| `DispatchManifest` — additive-safe (`schemaVersion`, self-hashed `manifestHash`); carries `actor`, `firedAt`, `inputRefs?`, `pipelineRef?`, `signature?`. New `authorization?` field goes here. | `packages/pangolin-core/src/audit.ts` |
| `AuditEntryKind` union (`run.submitted` … `item.skipped` … `run.extended`); each entry is canonicalized + hash-chained (`canonEntry` binds `seq`). New `item.denied` kind extends the union + must thread through canon. | `packages/pangolin-core/src/audit.ts`; `packages/pangolin-orchestrator/src/audit/canon.ts` (+ `core/src/audit-canon.ts`) |
| `effectTier` is computed by the effect policy and applied during the engine tick — currently discarded, not sealed. | `packages/pangolin-orchestrator/src/contracts/effect-policy.ts`; `src/engine/tick.ts`; `src/contracts/subagent-shape.ts` |
| The dispatch executor's fire path builds the manifest; the engine tick is where items become ready/fire and audit entries are emitted. **The fire gate + manifest sealing of the decision land here.** | `packages/pangolin-orchestrator/src/executors/dispatch.ts`; `src/audit/manifest.ts`; `src/engine/tick.ts` |
| Submission entry point (the submit-time pre-check gate). | `packages/pangolin-orchestrator/src/orchestrator.ts` |
| `VerificationReport` — additions must be **optional** (the KMS-work lesson: a required field breaks example/consumer report literals). | `packages/pangolin-core/src/audit.ts` |
| The seal core (hash-chain/Merkle/WORM/required-sig) is out of scope and not modified. | — |

## 4. The `Authorizer` seam

Dependency-light interface + types in `pangolin-core`:

```ts
export interface AuthorizationContext {
  phase: 'submit' | 'fire';
  actor: string;              // human:<id> | agent:<id> (the existing identity)
  shapeId: string;            // the SubagentShape being dispatched
  effectClass: string;        // the effectTier for this dispatch
  onBehalfOf?: string;        // the principal the work serves (delegation), if any
  inputRefs?: Record<string, string>;  // resolved at fire; absent at submit
  submittedAt?: string;
}

export type AuthorizationVerdict = 'allow' | 'deny' | 'not-evaluated';

export interface AuthorizationDecision {
  verdict: AuthorizationVerdict;
  principal: string;          // the authority that decided (who authorized)
  onBehalfOf?: string;        // echoed delegation principal
  policyRef: string;          // content-hash (sha256:…) of the deciding policy/ruleset — a REF, not the rules
  effectClass: string;        // the sealed effect class (folds in invariant #4)
  reason?: string;            // human-readable, for a deny or a conditional allow
  at: string;                 // ISO-8601 decision time
}

export interface Authorizer { authorize(ctx: AuthorizationContext): Promise<AuthorizationDecision>; }
```

Impls:
- **`NoneAuthorizer`** (orchestrator, default) — returns `{ verdict: 'not-evaluated', principal: 'none', policyRef: 'none', effectClass }`. Allow-all (never blocks). Mirrors `NoneSigner`; keeps demo/dev byte-identical and the whole feature additive.
- **In-tree config authorizer** (orchestrator) — a simple operator-supplied rules/allowlist authorizer (e.g., allow/deny by `actor` × `shapeId` × `effectClass`), **no external dependency**. The concrete, demoable impl that proves the seam end-to-end and seals real `allow`/`deny` decisions.
- **External policy engines** — future leaf packages `pangolin-authorizer-cedar` / `-opa` / `-cerbos` / customer-specific, each owning its engine SDK, **integrator-wired, never a core/orchestrator dependency** (orthogonality rule + the `check-dep-allowlist` guard). **Not built now**; the `signer-aws-kms` precedent shows the path. Per-engine, demand-pulled.

The orchestrator injects the `Authorizer` exactly as it injects the `Signer` (default `NoneAuthorizer` when none supplied).

## 5. The two gates

### 5.1 Submit-time pre-check (fail-fast, not sealed)
At the submission entry point (`orchestrator.ts`), call `authorize({ phase: 'submit', … })` per item. On `deny`, **reject the submission** (clear error to the caller; the run/item is never queued — cleanest "never ran"). Not sealed (nothing is queued to seal into). This reuses the spirit of the existing submit-gate validation. With `NoneAuthorizer` the verdict is `not-evaluated` → submission proceeds unchanged.

### 5.2 Fire-time binding decision (sealed, authoritative)
At the dispatch executor's fire path / engine tick, call `authorize({ phase: 'fire', inputRefs, effectClass, … })` — where the manifest is assembled and resolved refs/effect class are known.
- **`allow` / `not-evaluated`** → the `AuthorizationDecision` is written into `DispatchManifest.authorization` (§6); the dispatch runs and seals normally.
- **`deny`** → the item is **not** dispatched; it transitions to a terminal **`denied`** status; an **`item.denied`** audit entry carrying the decision is appended + hash-chained (§6) — so the **refusal is itself tamper-evident**. Other items in the run are unaffected (deny is per-item).

**Fail-closed reconciliation:** the fire decision is authoritative. If submit allowed but fire denies (policy/context changed, or fire sees resolved refs the pre-check couldn't), fire wins → blocked + sealed denial. The submit pre-check is strictly an optimization; it can never *grant* something fire would deny.

## 6. What gets sealed

- **Allowed dispatch:** an additive optional `authorization?: ManifestAuthorization` on `DispatchManifest` (wire-shape mirrors `ManifestSignature`'s base64/string discipline; values are strings/refs). It carries `verdict`, `principal`, `onBehalfOf?`, `policyRef` (content-hash), `effectClass`, `reason?`, `at`. Because it's in the manifest, it's already covered by the manifest self-hash + the hash-chain + Merkle root + signature → **tamper-evident with no new crypto.**
- **Effect-in-evidence:** `effectClass` rides the same `authorization` object (and is always set, even under `NoneAuthorizer`), so invariant #4 is closed in the same change.
- **Denied dispatch:** a new `item.denied` `AuditEntryKind`, carrying the `AuthorizationDecision`, appended to the per-run chain via `canonEntry` (seq-bound, hash-chained). No `DispatchManifest` (nothing executed). The denial is provable from the sealed chain.
- **Refs not values:** `policyRef` is a `sha256:` content-hash of the deciding ruleset (the auditor can pin *which* policy decided without the rules leaking into the bundle) — same discipline as `secretRefs`/`inputRefs`.

## 7. Verify dimension — `authzTier`

Add an **optional** `authzTier?` to `VerificationReport` (`packages/pangolin-core/src/audit.ts`), orthogonal to `intact`/`claim`:

- `none` — no authorization sealed / `NoneAuthorizer` (`verdict: 'not-evaluated'`). Honest default.
- `recorded` — a real `allow`/`deny` decision is sealed, **self-asserted by the operator's injected policy** (the common built tier).
- `authority-attested` *(reserved)* — the decision is independently verifiable (e.g. signed by an external authority a verifier checks via an injected verifier), analogous to `tsa-attested`. **Not built now**; reserved like the `witnessed` tamper tier.

Verify **reads** the sealed `authorization` out of the manifest (and any `item.denied` entries) and reports `authzTier` — **no new injected verifier needed for `recorded`** (the evidence is already integrity-protected by the existing chain/root/signature). `authzTier` never affects `intact`/`claim`/`failure`. `verifyBundle` surfaces it; `agora verify` print shows it as a separate line.

## 8. Honesty bounds

- `NoneAuthorizer` / `authzTier: 'none'` → verify and `agora verify` print state authorization was **not** attested. Update the `agora verify` "does NOT attest authorization-scope" line (`spec-agora-verify-print-design`) to reflect the new tiers (it now *can* attest a recorded decision; it still does not attest mid-run action governance).
- A `recorded` decision is **operator-self-asserted**, not third-party attested — stated plainly (mirrors the demo-key honesty bound from the custody work).
- Mid-run action governance remains explicitly out of scope (§11).

## 9. Default / back-compat

Fully additive. With no `Authorizer` injected, the orchestrator uses `NoneAuthorizer`: every dispatch is `not-evaluated` (runs), `authorization` is sealed with `verdict:'not-evaluated'` + the `effectClass`, `authzTier` is `none`, and no submission is ever rejected. Existing examples/e2e behave identically except the manifest now carries the (optional) `authorization` block — which is why the `VerificationReport` addition is **optional** and the manifest field is optional + versioned.

## 10. Blast radius + verification gate

- **Core (additive):** `Authorizer`/`AuthorizationContext`/`AuthorizationDecision`/`AuthorizationVerdict` types; optional `authorization?` on `DispatchManifest`; new `item.denied` `AuditEntryKind`; optional `authzTier?` on `VerificationReport`. The `item.denied` kind + the manifest field must thread through `canonEntry`/manifest-hash consistently (a new sealed field changes the canonical bytes — additive, but tests pinning manifest/entry hashes update).
- **Orchestrator:** `NoneAuthorizer` + in-tree config authorizer; injection; the submit pre-check; the fire gate + `denied` status + `item.denied` emission; seal the `authorization` into the manifest; surface `authzTier` in `verifyBundle`/print.
- **Optional-field discipline:** keep `authzTier`/`authorization` optional so example/consumer `VerificationReport`/manifest literals don't break (the KMS-work lesson). Expect to update audit conformance vectors (manifest/entry hashes change when the new sealed fields are populated) — fix fixtures to the new honest values, never by loosening.
- **Full gate:** `pnpm -r typecheck` + `pnpm -r test` + `pnpm test:e2e` (separate CI job) + `pnpm -r lint`; fresh-worktree `pnpm install && pnpm -r build` before trusting cross-package failures.

## 11. Out of scope

- **Mid-run action interception** (denying the agent's individual tool calls with on-behalf-of delegation) — the threat-model's deferred "fine-grained action-denial"; different architecture (tool-call interposition the worker deliberately avoids).
- **Picking a specific policy engine** (Cedar/OPA/Cerbos) — deferred per-engine to a partner pull; only the seam + `NoneAuthorizer` + the in-tree config authorizer ship now.
- **`authority-attested` tier** (signed/independently-verifiable decisions) — reserved.
- **Sealing rejected *submissions*** — a submit-time deny is a fast reject (never queued); the binding sealed record is the fire-time `item.denied`.
- The seal cryptographic core — untouched.

## 12. Acceptance

1. An allowed dispatch seals an `authorization` block (verdict + principal + policyRef + effectClass) into its `DispatchManifest`; `verifyBundle` reports `authzTier: 'recorded'`; the block is covered by the existing tamper-evidence (mutating it fails verify).
2. A fire-time `deny` blocks the dispatch (item terminal `denied`), seals an `item.denied` audit entry carrying the decision, and that entry is hash-chained (tamper-evident); other items in the run still run.
3. A submit-time `deny` rejects the submission with a clear error; nothing is queued.
4. `NoneAuthorizer` (default) → every dispatch runs, `authzTier: 'none'`, `effectClass` still sealed; all existing examples/e2e stay green.
5. `effectClass` is sealed into the manifest for every dispatch (invariant #4 closed).
6. `authzTier` is orthogonal: a tamper-evident bundle can show `authzTier: 'none'` or `'recorded'`; authorization never changes `intact`/`claim`.
7. An external policy engine is reachable only as an integrator-wired `Authorizer` impl; `pangolin-core`/orchestrator gain no policy-engine dependency (dep-allowlist guard stays green).
8. Full gate green (`typecheck` + `test` + `test:e2e` + `lint`).
