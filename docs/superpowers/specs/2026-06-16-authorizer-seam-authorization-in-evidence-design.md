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
| `Signer` interface lives in core (dependency-light); `NoneSigner`/`createLocalSigner` (defaults/local) live in the orchestrator; production adapter is a leaf (`pangolin-signer-aws-kms`). **Pattern to mirror for the seam — but NOT the injection topology:** the `Signer` is injected into `AuditLog` (`audit-log.ts`, `deps.signer`, used only in `sealEpoch`), via the example wiring `new AuditLog({ signer, … })`. The `Authorizer` is consulted at **submit** (orchestrator) and **fire** (tick/executor), so it needs a **different, two-site injection** — see §3.1 + §4. | `packages/pangolin-core/src/audit.ts` (interface); `packages/pangolin-orchestrator/src/audit/signer.ts`; `audit/audit-log.ts` (injection); `packages/pangolin-signer-aws-kms/` |
| `DispatchManifest` — additive-safe (`schemaVersion`, self-hashed `manifestHash`); carries `actor`, `firedAt`, `inputRefs?`, `pipelineRef?`, `signature?`. New `authorization?` field goes here. | `packages/pangolin-core/src/audit.ts` |
| `AuditEntryKind` union (`run.submitted` … `item.skipped` … `run.extended`); each entry is canonicalized + hash-chained (`canonEntry` binds `seq`). New `item.denied` kind extends the union + must thread through canon. | `packages/pangolin-core/src/audit.ts`; `packages/pangolin-orchestrator/src/audit/canon.ts` (+ `core/src/audit-canon.ts`) |
| `effectTier` is computed by the effect policy and applied during the engine tick — currently discarded, not sealed. | `packages/pangolin-orchestrator/src/contracts/effect-policy.ts`; `src/engine/tick.ts`; `src/contracts/subagent-shape.ts` |
| The dispatch executor's fire path builds the manifest; the engine tick is where items become ready/fire and audit entries are emitted. **The fire gate + manifest sealing of the decision land here.** | `packages/pangolin-orchestrator/src/executors/dispatch.ts`; `src/audit/manifest.ts`; `src/engine/tick.ts` |
| Submission entry point (the submit-time pre-check gate). | `packages/pangolin-orchestrator/src/orchestrator.ts` |
| `VerificationReport` — add `authzTier?` **optional**. (Precise reason: test-dir report literals are out of typecheck scope, so a required field wouldn't break *them*; the real in-scope break sites are the report **constructors** — the `verify` return (`audit-verify.ts`) and `docs-site/src/lib/sealVerify.ts`. Optional keeps it additive and lets `verify` set it unconditionally.) | `packages/pangolin-core/src/audit.ts:121-129`; `audit-verify.ts`; `docs-site/src/lib/sealVerify.ts` |
| The seal core (hash-chain/Merkle/WORM/required-sig) is out of scope and not modified. | — |

### 3.1 Audit-surfaced corrections (2026-06-16) — folded into the design below

The spec audit + security review confirmed the design is faithful and correctly scoped, and surfaced these grounding corrections (all reflected in §§4–12):

- **(A — load-bearing) `verify` does NOT currently check manifest integrity.** `verifyBundle` reads `bundle.manifests[*]` only for handoff closure; nothing recomputes a manifest's content hash and compares it to the `manifestRef` content-hash sealed in the chain. So "mutating the sealed `authorization` block fails verify" is **not true today** — and the gap equally affects `inputRefs`/`secretRefs`/`actor`/`effectClass`. **This build adds a manifest-integrity check** (recompute `manifestHash` / `computeContentHash(manifest)` and confirm it equals the chained `manifestRef`) + a negative test. It is a small, general strengthening of the seal that the authorization-evidence claim depends on (§6, §10, §12).
- **(Injection) two sites, not one.** Inject the `Authorizer` into the **orchestrator** (submit gate) and into **`FireContext`/the dispatch executor** (fire gate) — *not* the single `AuditLog` seam the `Signer` uses (§4, §5).
- **(`denied` status) wire into both terminal state machines.** Add `'denied'` to `TERMINAL_STATUSES` (`orchestrator.ts:40`) and treat it as a skip-trigger in `computeSkipped` (`engine/dep-resolver.ts:55`) — otherwise a run with a denied item **never seals** and the denied item's dependents **hang `pending`** (§5.2, §10, §12).
- **(Fire-gate placement) before container start.** The fire-time `authorize()` runs in `engine/tick.ts` **before** `ex.fire()` (the executor's container start at `executors/dispatch.ts`), not inside the post-start manifest-build block (§5.2).
- **(`FireContext` + `AuditEntry` plumbing) two additive core/contract changes:** `FireContext` (`contracts/executor.ts`) gains `effectClass` so fire can seal it + authorize on it; `AuditEntry` + `canonEntry` (`core/src/audit-canon.ts`, positional array) gain an **append-only** field to carry the `AuthorizationDecision` on an `item.denied` entry (append after `seq` to keep existing conformance vectors valid) (§6, §10).
- **(effectClass provenance) from the shape, never the inputs.** The `effectClass` fed to `authorize()` and sealed must come from the resolved `shape.effectTier` (`tick.ts`), **not** `item.inputs` — else a submitter could self-downgrade their effect class to dodge a deny rule. Items with no `subagentShape` (raw executor items) need a defined default effect class (§5).
- **(dep-allowlist guard) don't over-claim.** `scripts/check-dep-allowlist.mjs` is a four-prefix **denylist**, not an allowlist — it would NOT catch a stray `cedar`/`@cerbos/*`/`@openpolicyagent/*` dep added to core/orchestrator. Orthogonality is enforced by the engine adapters being separate leaf packages that core/orchestrator simply never import — not by the guard (§4, §12).
- **(`reason` is bundle-visible) bound + document.** `AuthorizationDecision.reason` rides into the distributable bundle; document "no secrets/PII," bound its length (mirror the 16KB `verify.report` slice), and keep submit-deny errors generic to limit policy-oracle leakage (§6, §8).

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
- **External policy engines** — future leaf packages `pangolin-authorizer-cedar` / `-opa` / `-cerbos` / customer-specific, each owning its engine SDK, **integrator-wired, never a core/orchestrator dependency**. Orthogonality is enforced by these being separate leaf packages that core/orchestrator simply never import — **not** by `scripts/check-dep-allowlist.mjs` (a four-prefix denylist that would not catch a stray `cedar`/`@cerbos/*`/`@openpolicyagent/*` dep). **Not built now**; the `signer-aws-kms` precedent shows the path. Per-engine, demand-pulled.

**Injection (two sites — NOT the `Signer`'s single `AuditLog` seam).** The `Authorizer` is consulted at submit and fire, so it is injected in two places, both defaulting to `NoneAuthorizer` when not supplied: (1) into the **orchestrator** (`PangolinOrchestratorOptions`) for the submit pre-check; (2) into the **fire path** — threaded via `FireContext`/`DispatchExecutor` (`contracts/executor.ts`) — for the binding decision. (`AuditLog` is unchanged; it still only holds the `Signer`.)

## 5. The two gates

### 5.1 Submit-time pre-check (fail-fast, not sealed)
At the submission entry point (`orchestrator.ts` `submitRun`), alongside the existing `validateRun` gate, call `authorize({ phase: 'submit', … })` per item. **Context available at submit:** `actor`, `shapeId`, and `effectClass` — the latter by resolving the shape against the orchestrator's `packs` (as `validateRun`/`run-validator.ts` already does); `inputRefs` are **not** resolved yet (hence `inputRefs?` is optional and submit is best-effort). **Items with no `subagentShape`** (raw executor items) have no shape-derived effect class — they take a defined default effect class (e.g. `unknown`/most-restrictive) for the pre-check. On `deny`, **reject the submission** with a **generic** error ("submission denied by policy" — do not echo the matched rule, to limit policy-oracle probing); the run/item is never queued. Not sealed (nothing queued). With `NoneAuthorizer` the verdict is `not-evaluated` → submission proceeds unchanged.

### 5.2 Fire-time binding decision (sealed, authoritative)
Call `authorize({ phase: 'fire', inputRefs, effectClass, … })` in **`engine/tick.ts`, BEFORE `ex.fire()`** — i.e. before the dispatch executor starts the container (`executors/dispatch.ts`). The resolved `inputRefs` + shape `effectClass` are in scope in the tick fire loop. **The gate must precede container start** — not sit inside the post-`fire` manifest-build block, or a denied dispatch would already have launched. `effectClass` here comes from the resolved `shape.effectTier`, never from `item.inputs` (so a submitter can't self-downgrade to dodge a deny rule).
- **`allow` / `not-evaluated`** → the `AuthorizationDecision` (incl. `effectClass`) is threaded via `FireContext` into the `DispatchManifest.authorization` block built by the executor (§6); the dispatch runs and seals normally.
- **`deny`** → the executor is **not** called; the item transitions to a terminal **`denied`** status; an **`item.denied`** audit entry carrying the decision is appended + hash-chained (§6) — so the **refusal is itself tamper-evident**. Other items in the run are unaffected (deny is per-item). **`denied` MUST be added to `TERMINAL_STATUSES` (`orchestrator.ts`) and treated as a skip-trigger in `computeSkipped` (`engine/dep-resolver.ts`)** — otherwise the run never satisfies the seal predicate (never seals) and the denied item's dependents hang `pending`.

**Fail-closed reconciliation:** the fire decision is authoritative. If submit allowed but fire denies (policy/context changed, or fire sees resolved refs the pre-check couldn't), fire wins → blocked + sealed denial. The submit pre-check is strictly an optimization; it can never *grant* something fire would deny.

## 6. What gets sealed

- **Allowed dispatch:** an additive optional `authorization?: ManifestAuthorization` on `DispatchManifest` (wire-shape mirrors `ManifestSignature`'s base64/string discipline; values are strings/refs). It carries `verdict`, `principal`, `onBehalfOf?`, `policyRef` (content-hash), `effectClass`, `reason?`, `at`. The manifest has a self-hash (`manifestHash`) and is referenced from the chained `item.fired` entry by `manifestRef` (a content-hash bound into `canonEntry`).
- **REQUIRED — manifest-integrity check (Finding A).** For "mutating the sealed `authorization` fails verify" to actually hold, `verify`/`verifyBundle` must **recompute each manifest's content hash and confirm it equals the chained `manifestRef`** — which it does **not** do today (verify reads manifests only for handoff closure). This build adds that check + a negative test (mutate `authorization` → verify fails). It is a small, general strengthening that also closes the same latent gap for `actor`/`inputRefs`/`secretRefs`/`effectClass`. Until this lands, the manifest-block tamper-evidence claim is NOT true — so it is a first-class task, not an assumption.
- **Effect-in-evidence:** `effectClass` rides the same `authorization` object (and is always set, even under `NoneAuthorizer`), so invariant #4 is closed in the same change. It comes from `shape.effectTier`, sealed once in the manifest.
- **Denied dispatch:** a new `item.denied` `AuditEntryKind` carrying the `AuthorizationDecision`. `AuditEntry` today has no free-form payload field, and `canonEntry` (`core/src/audit-canon.ts`) is a positional array — so add an **append-only** optional field (after `seq`, to keep existing conformance vectors valid) that holds the decision and is hash-bound. Appended + seq-contiguity-checked + Merkle-rooted + anchored like every other entry. No `DispatchManifest` (nothing executed). The denial is provable from the sealed chain.
- **Refs not values:** `policyRef` is a `sha256:` content-hash of the deciding ruleset (pin *which* policy decided without the rules leaking) — same discipline as `secretRefs`/`inputRefs`. `reason` is human-readable and **bundle-visible** — document "no secrets/PII" and bound its length (mirror the 16KB `verify.report` slice in `dispatch.ts`).

## 7. Verify dimension — `authzTier`

Add an **optional** `authzTier?` to `VerificationReport` (`packages/pangolin-core/src/audit.ts`), orthogonal to `intact`/`claim`:

- `none` — no authorization sealed / `NoneAuthorizer` (`verdict: 'not-evaluated'`). Honest default.
- `recorded` — a real `allow`/`deny` decision is sealed, **self-asserted by the operator's injected policy** (the common built tier).
- `authority-attested` *(reserved)* — the decision is independently verifiable (e.g. signed by an external authority a verifier checks via an injected verifier), analogous to `tsa-attested`. **Not built now**; reserved like the `witnessed` tamper tier.

Verify **reads** the sealed `authorization` out of the manifest (and any `item.denied` entries) and reports `authzTier` — **no new injected verifier needed for `recorded`** (no extra crypto: the decision is integrity-protected by the chain/root/signature **once the §6 manifest-integrity check binds the manifest body to the chained `manifestRef`** — that check is the prerequisite that makes reading the sealed decision trustworthy). `authzTier` never affects `intact`/`claim`/`failure`. `verifyBundle` surfaces it; `agora verify` print shows it as a separate line (keeping the self-asserted qualifier so `recorded` never reads as third-party-attested).

## 8. Honesty bounds

- `NoneAuthorizer` / `authzTier: 'none'` → verify and `agora verify` print state authorization was **not** attested. Update the `agora verify` "does NOT attest authorization-scope" line (`spec-agora-verify-print-design`) to reflect the new tiers (it now *can* attest a recorded decision; it still does not attest mid-run action governance).
- A `recorded` decision is **operator-self-asserted**, not third-party attested — stated plainly (mirrors the demo-key honesty bound from the custody work).
- Mid-run action governance remains explicitly out of scope (§11).

## 9. Default / back-compat

Fully additive. With no `Authorizer` injected, the orchestrator uses `NoneAuthorizer`: every dispatch is `not-evaluated` (runs), `authorization` is sealed with `verdict:'not-evaluated'` + the `effectClass`, `authzTier` is `none`, and no submission is ever rejected. Existing examples/e2e behave identically except the manifest now carries the (optional) `authorization` block — which is why the `VerificationReport` addition is **optional** and the manifest field is optional + versioned.

## 10. Blast radius + verification gate

- **Core (additive):** `Authorizer`/`AuthorizationContext`/`AuthorizationDecision`/`AuthorizationVerdict` types; optional `authorization?` on `DispatchManifest`; new `item.denied` `AuditEntryKind` + an **append-only** decision field on `AuditEntry`/`canonEntry`; optional `authzTier?` on `VerificationReport`; **the new manifest-integrity check in `verify`/`verifyBundle` (Finding A)** + `authzTier` derivation. New sealed fields change canonical bytes → conformance vectors update.
- **Orchestrator/engine:** `NoneAuthorizer` + in-tree config authorizer; **two injection points** (orchestrator for submit; `FireContext` for fire); the submit pre-check (resolve shape from `packs`; default effect class for shapeless items; generic deny error); the fire gate in `tick.ts` **before `ex.fire()`**; `effectClass` threaded through `FireContext`; seal `authorization` into the manifest; **add `denied` to `TERMINAL_STATUSES` + `computeSkipped`**; emit `item.denied`; surface `authzTier` in `verifyBundle`/print.
- **Optional-field discipline:** keep `authzTier`/`authorization` optional so example/consumer `VerificationReport`/manifest literals don't break (the KMS-work lesson). Expect to update audit conformance vectors (manifest/entry hashes change when the new sealed fields are populated) — fix fixtures to the new honest values, never by loosening.
- **Full gate:** `pnpm -r typecheck` + `pnpm -r test` + `pnpm test:e2e` (separate CI job) + `pnpm -r lint`; fresh-worktree `pnpm install && pnpm -r build` before trusting cross-package failures.

## 11. Out of scope

- **Mid-run action interception** (denying the agent's individual tool calls with on-behalf-of delegation) — the threat-model's deferred "fine-grained action-denial"; different architecture (tool-call interposition the worker deliberately avoids).
- **Picking a specific policy engine** (Cedar/OPA/Cerbos) — deferred per-engine to a partner pull; only the seam + `NoneAuthorizer` + the in-tree config authorizer ship now.
- **`authority-attested` tier** (signed/independently-verifiable decisions) — reserved.
- **Sealing rejected *submissions*** — a submit-time deny is a fast reject (never queued); the binding sealed record is the fire-time `item.denied`.
- The seal cryptographic core — untouched.

## 12. Acceptance

1. An allowed dispatch seals an `authorization` block (verdict + principal + policyRef + effectClass) into its `DispatchManifest`; `verifyBundle` reports `authzTier: 'recorded'`.
2. **Manifest-integrity (Finding A):** with the new check in place, **mutating the sealed `authorization` block (e.g. `deny`→`allow`) makes verify report not-intact** (manifest hash ≠ chained `manifestRef`). A negative test asserts this. (Establishes the property #1 relies on.)
3. A fire-time `deny` blocks the dispatch (item terminal `denied`), seals an `item.denied` entry carrying the decision (hash-chained, tamper-evident); other items still run; **the run still seals** and the denied item's dependents cascade to `skipped`.
4. A submit-time `deny` rejects the submission with a **generic** error; nothing is queued.
5. `NoneAuthorizer` (default) → every dispatch runs, `authzTier: 'none'`, `effectClass` still sealed; all existing examples/e2e stay green.
6. `effectClass` is sealed for every dispatch (invariant #4 closed) and is sourced from `shape.effectTier`, **not** `item.inputs` — a negative test confirms a submitter can't self-downgrade it.
7. `authzTier` is orthogonal: a tamper-evident bundle can show `authzTier: 'none'` or `'recorded'`; authorization never changes `intact`/`claim`/`failure`.
8. An external policy engine is reachable only as an integrator-wired `Authorizer` impl; `pangolin-core`/orchestrator import no policy-engine package (verified by inspection — the dep-allowlist denylist does not itself cover this).
9. Full gate green (`typecheck` + `test` + `test:e2e` + `lint`).
