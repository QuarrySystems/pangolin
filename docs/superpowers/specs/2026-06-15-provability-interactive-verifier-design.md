# Provability — interactive seal verifier (design)

**Status:** draft · **Date:** 2026-06-15 · **Owner:** Brett

## 1. Purpose

A browser-interactive demo that lets a visitor *try to break a Pangolin audit seal* and
watch verification catch them — or, on the local tier, watch it honestly admit it can't.
Its job is **sales credibility through demonstrability**: for a tamper-evidence product
whose entire differentiator is *honesty about what is proven*, the strongest asset is
letting a skeptic tamper and see the claim respond truthfully.

It ships as a prominent **"Provability"** page in the docs-site, and is also embeddable as
an island inside `explanation/audit-guarantee-tiers`.

This design supersedes the generic hash-chain mock by making it faithful to the real
`VerificationReport` returned by `verify()` in `packages/pangolin-core/src/audit-verify.ts`.

## 2. What stays from the mock

The existing React mock (dark palette, pangolin **scale mark**, plan **DAG** with measured
SVG edges, ripple animation, real in-browser **SHA-256**, and the **tampered-vs-broken**
node distinction) is the visual base and is kept. The DAG legitimately represents the
**offload plan** (a DAG of items with `depends_on`). We add semantic depth, not a redesign.

## 3. What this is NOT (scope / YAGNI)

- **No `bundle.json` loader.** Synthetic data only. Loading a real exported bundle and
  running offline verify in-browser is the agreed **phase 2** and out of scope here.
- **No network / no real S3 / no real TSA.** The anchor and the external anchored root are
  *simulated in-browser*. The **logic** is faithful; the **transport** is mocked.
- **No real ed25519.** The signature is modeled as a boolean predicate (see §5.4), not a
  real keypair. SHA-256 hashing remains real (it is what makes the ripple honest).
- No backend, no persistence, no analytics beyond whatever the docs-site already has.

## 4. Faithful model — mapping mock fields to the real contract

All real field names below are verified against source (file:line in parentheses).

| Demo surface | Real concept (verified) |
|---|---|
| DAG node | a plan item: `WorkItem` with `id` + `depends_on: string[]` (`orchestrator/src/contracts/types.ts:29`), realised as a `DispatchManifest` (`core/src/audit.ts:26-45`) |
| node "adapter/action" labels | `DispatchManifest.executor` / `executorManifest` — **not** "adapter"; real executor value is e.g. `"dispatch"` |
| node `credential.scope` | the grant scope sealed into the manifest (annotation; the bundle seals refs/hashes) |
| node `credential.ref` (`tok_*`) | an entry of `DispatchManifest.secretRefs: string[]` (`core/src/audit.ts:33`) — a **reference**; the secret *value* never enters the bundle |
| node `output.payload` | shown decoded for legibility, but what is actually sealed is `AuditItemOutcome.resultRef` (`core/src/audit.ts:142-148`) — a content reference, never the inline value |
| per-node hash | entry hash in the hash-chained lifecycle log (`AuditEntryKind`: `run.submitted` · `item.fired` · `item.reconciled` · `item.retried` · `item.skipped` · `run.cancelled` · `run.completed` · `run.extended` — `core/src/audit.ts:105-108`) |
| root seal | Merkle root over entry hashes |
| "External anchor" meta row | the configured `AuditAnchor` (now an interactive tier toggle) |
| verdict | `VerificationReport.claim` + `timeTier` (two axes, see §5.2) |
| checklist | `VerificationReport.checks` = `{ chain, root, signature, anchor, handoff, time }`, each `CheckResult { ok: boolean \| 'n/a'; detail? }` (`core/src/audit.ts:116-129`) |

**Faithfulness note (refs, not values).** Real bundles store *references and hashes*, never
the inline patch/output values (`secretRefs`, `resultRef`, `inputRefs`, `manifestHash`). The
demo surfaces human-readable decoded values (e.g. `cost_delta=$4,275`) purely for legibility,
and the seal/hash is computed over the manifest-level fields — consistent with the product's
"refs only, never secret values" rule. Tampering a shown value stands in for tampering the
sealed manifest field it decodes.

## 5. The three interactions

Each interaction teaches exactly one truth. All verification is recomputed live on every
state change with real SHA-256.

### 5.1 Tamper a sealed field *(kept from mock)*

The user edits `output.payload` or `credential.scope` on a node (via the three preset
tamper buttons — alter price / forge authority / rewrite scope — or by direct edit). The
node's recomputed entry hash diverges from the sealed hash → that node is **tampered**;
downstream nodes whose own fields are intact but depend on it are **broken**. Teaches: *the
chain catches mutation, and the break ripples to the root.*

### 5.2 Flip the anchor tier *(new — the differentiator)*

A toggle on the anchor row: **`LocalAnchor (detect)`** ↔ **`S3 Object Lock
(external-immutable)`**. On a **clean** bundle, flipping the toggle changes the verdict
between **`tamper-detecting`** and **`tamper-evident`** with *nothing else changing*.
Teaches: *the guarantee comes from where the root lives, not from the bundle.* This is the
**primary, architecturally-robust** tier mechanism: `claimFor()` gates `tamper-evident` on
`GUARANTEE_RANK[guarantee] >= GUARANTEE_RANK['external-immutable']` (`audit-verify.ts:10-20`,
`audit.ts:62`). The local tier can therefore *never* reach `tamper-evident` **regardless of
signature**, purely by the rank gate. The verified-signature requirement is a *second,
independent* condition for `tamper-evident` (see §6); do not present the signature as the
reason local downgrades — the rank gate is.

The verdict is presented as **two orthogonal axes**, never collapsed:

- **Tamper axis:** `tamper-detecting` / `tamper-evident` / `TAMPERED` (when `intact:false`).
- **Time axis:** `time: asserted` / `time: tsa-attested`, with an "attach RFC-3161
  timestamp" toggle. Turning time on/off **never** changes the tamper claim — demonstrating
  the orthogonality the explanation page is emphatic about.

### 5.3 Re-seal as the attacker *(new — the climax)*

After any tamper, a button appears: **"Re-seal the bundle (act as the attacker)."** It
recomputes the stored entry hashes from the now-tampered fields (repairing the internal
chain), then attempts to update the anchored root. The outcome depends on the tier:

- **On `LocalAnchor`:** re-seal **succeeds**, verdict returns to green
  (`intact:true, claim:tamper-detecting`). Caption (red): *"The root lives in the same store
  the attacker controls — rewrite the log, rewrite the root. The local tier proves
  consistency, not immutability. That is why it only ever claims tamper-detecting."*

- **On `S3 Object Lock`:** re-seal **fails** with `failure: 'root-mismatch'` — the *primary*
  catch is that the anchored root is **immutable**, so the recomputed root no longer matches
  it. Caption: *"The anchored root is in a separate trust domain (WORM). The attacker rewrote
  the bundle — but not the anchor. That is tamper-evident."* The attacker also could not
  forge the signature over a new root (no signing key — the seal-signing-key-custody KMS
  concern), but `root-mismatch` fires first and is the load-bearing reason.

This dramatizes the load-bearing fact from the how-to page: `verify` compares against the
**live external anchored root**, never the bundle's embedded copy.

## 6. State model (precise, faithful)

```
bundle        : editable plan items (fields the user can tamper)
storedHashes  : per-entry hash snapshot from the last seal (what the "log" claims)
anchoredRoot  : the Merkle root the anchor holds
anchorTier    : 'local' | 's3-worm'
timeAttested  : boolean (RFC-3161 token attached?)
```

On every change, derive a faithful `VerificationReport`:

1. **chain**: recompute each entry hash from current `bundle`; `chainOk` ⇔ recomputed ==
   `storedHashes` (and prevHash linkage holds). Tampering without re-sealing breaks it;
   re-sealing repairs it (it rewrites `storedHashes`).
2. **root**: `recomputedRoot == anchoredRoot`.
3. **signature** (`sigOk`): mirrors real `verify()` —
   `sigOk = anchored.signature && verifierSupplied ? verify(root, sig) : 'n/a'`
   (`audit-verify.ts:70-73`).
   - **Correction (audit finding):** `LocalAnchor` does *not* strip signatures — it accepts
     and stores them (`anchor.ts:12,19`). The demo models the **default local configuration**,
     in which no verified signature is attached, so `sigOk = 'n/a'`. This is a config fact,
     not an architectural one. Crucially, local stays `tamper-detecting` even *with* a valid
     signature, because of the §5.2 rank gate — so `sigOk` is **not** the reason local
     downgrades. `'n/a'` does not fail `intact`.
   - `s3-worm` tier: `sigOk = true` iff `anchoredRoot` is the honest, operator-signed root.
     Because WORM freezes `anchoredRoot`, the catch on attacker re-seal is `root-mismatch`
     (recomputed ≠ frozen anchored), which `verify()` surfaces before `signature`.
4. **anchor**: `anchorOk` ⇔ an anchored root exists (always true here).
5. **time**: `timeAttested ? 'tsa-attested' : 'asserted'` — informational, never gates the
   claim.

`handoff` is **not** evaluated by bare `verify()` (it is assigned only by `verifyBundle()`,
`audit-verify-bundle.ts:20-21`); for this single-run demo it is `{ ok: 'n/a' }` and is omitted
from the rendered checklist (§7).

Re-seal semantics:
- `local`: `storedHashes := recompute(bundle)`; `anchoredRoot := recomputedRoot`. Attacker
  succeeds.
- `s3-worm`: `storedHashes := recompute(bundle)`; **`anchoredRoot` is frozen** (immutable) →
  `root-mismatch`. Attacker caught.

`claim = claimFor(intact, guarantee, sigOk)` — reuse the real rule:
`intact && rank(guarantee) >= rank('external-immutable') && sigOk === true ? 'tamper-evident'
: 'tamper-detecting'`.

`failure` = first failing check in order `chain → anchor → root → signature` (mirrors
`verify()`).

**Restore** resets `bundle` to pristine and re-anchors the honest root (clean sealed state).

## 7. Checklist rendering

A checklist that echoes what `pangolin verify` prints, driven by `report.checks`:

```
chain      ✓ | ✗   N entries, hash-linked, no gaps
root       ✓ | ✗   merkle <hex…>  =|≠  anchored root
signature  ✓ | n/a ed25519 / pangolin-prod
anchor     ✓        s3:demo-bucket  (external-immutable) | local (detect)
time       ✓ | n/a  RFC-3161 token
```

Looking like the real CLI output is itself a credibility signal.

## 8. Integration (Astro / Starlight)

**Dependencies (docs-site currently has *no* UI framework — verified):**
- Add `@astrojs/react`, `react`, `react-dom`, `lucide-react` to `docs-site/package.json`.
- Add `@quarry-systems/pangolin-core: "workspace:*"` — used **type-only** (see §9 / module
  layout). docs-site is in the pnpm workspace, so this is a workspace link, not a registry dep.
- Register `react()` in the `astro.config.mjs` `integrations` array.
- `tsconfig.json` already extends `astro/tsconfigs/strict` (JSX syntax supported); `.tsx`
  compiles once `@astrojs/react` is present. No tsconfig change needed.

**Module layout (SRP / SoC — see §12):**
- `docs-site/src/lib/sealVerify.ts` — pure, framework-free: `sealBundle()`, `deriveReport()`,
  the mirrored `claimFor` rule. Returns the real `VerificationReport` type (type-only import).
- `docs-site/src/lib/demoBundle.ts` — the synthetic change-order plan + tamper presets (data).
- `docs-site/src/components/ProvabilityVerifier.tsx` — presentation/state orchestration.
- `docs-site/src/components/` — split sub-components (`Graph`, `Node`, `Detail`, `Verdict`,
  `Checklist`) rather than one monolith.

**Page + nav:**
- New page `docs-site/src/content/docs/provability.mdx` (must be `.mdx` to embed the island).
  Frontmatter needs only `title` + `description` (Starlight's standard `docsSchema()`; no
  custom content schema — verified). Renders `<ProvabilityVerifier client:only="react" />`.
- `client:only="react"` (not `client:load`): the island needs `crypto.subtle` + DOM
  measurement and has no useful SSR output.
- Add a **top-level** sidebar entry in `astro.config.mjs` of the same form the site already
  uses for single top-level pages (cf. `{ label: 'Commercial & pilots', slug: 'commercial' }`):
  `{ label: 'Provability', slug: 'provability' }`. Place it high (e.g. above "Use cases") so
  it is not buried.
- Also embed the island in `explanation/audit-guarantee-tiers` at the two-claims section.
- `starlightLinksValidator` runs with `errorOnRelativeLinks`/`errorOnInvalidHashes` — the new
  page must be registered in the sidebar and any internal links must resolve, or `astro build`
  fails. Cross-link the new page ↔ `audit-guarantee-tiers` ↔ `how-to/verify-audit-bundle`.

## 9. Testing

**Harness gap (audit finding):** docs-site currently has **no test runner** — no vitest, no
`test` script. The repo standard is per-package `"test": "vitest run"` (e.g. `pangolin-core`),
and root CI runs `pnpm -r test`. So this work must **add vitest to docs-site** (dev-dep +
`"test": "vitest run"` + minimal `vitest.config.ts`), which also opts docs-site into the
repo-wide gate: `pnpm-workspace.yaml` already lists `docs-site`, and root `test` is
`pnpm -r run test` (verified), so a `test` script in docs-site is picked up automatically —
today it has none, so `-r` simply skips it.

**DRY / zero-drift (audit finding):** `sealVerify.ts` imports the **real contract types**
type-only from `@quarry-systems/pangolin-core`
(`import type { VerificationReport, CheckResult, Guarantee, TimeTier } from ...`) so the demo's
report shape is *compile-enforced* identical to production, at zero runtime cost. The one-line
`claimFor` *rule* is mirrored locally (a runtime import risks pulling Node `Buffer` from
`audit-verify.ts` into the browser bundle — implementation must confirm whether a Buffer-free
export path exists; if so, import it instead of mirroring).

**Unit (pure `deriveReport(state)` — framework-free, vitest):**
  - clean + local → `tamper-detecting`, `sigOk:'n/a'`, `intact:true`.
  - clean + s3-worm → `tamper-evident`, `sigOk:true`.
  - clean + s3-worm + timeAttested → still `tamper-evident`, `timeTier:'tsa-attested'`.
  - clean + s3-worm + valid signature, then flip to local → `tamper-detecting` purely via the
    rank gate (signature unchanged) — guards the §5.2 correction.
  - tamper, no reseal → `intact:false`, `failure:'chain'`.
  - tamper + reseal + local → `intact:true`, `tamper-detecting` (attacker wins).
  - tamper + reseal + s3-worm → `intact:false`, `failure:'root-mismatch'` (attacker caught).
- **claimFor parity guard:** assert the mirrored rule equals the real truth table for all
  `(intact, guarantee, sigOk)` combinations, so the demo can never drift into overclaiming.
- **Build:** `astro build` succeeds with the React integration and the link validator passes.
- **Visual smoke:** the three interactions behave as specified in a real browser (real
  SHA-256, ripple, captions).

## 10. Honesty constraints (inherited, non-negotiable)

The demo obeys the same vocabulary discipline as the product:
- "tamper-evident" rendered **only** at `external-immutable`+ with a verified signature.
- `LocalAnchor` is **never** labelled tamper-evident or compliant.
- Copy says "compliance-ready," never "compliant" / "certified" / "reproducible."
- The time axis is shown separately and never silently upgrades the tamper claim.

## 11. Design principles (DRY / SRP / SoC)

- **DRY.** The contract types come from `@quarry-systems/pangolin-core` (type-only), not a
  hand-rolled copy. The `claimFor` rule is mirrored once with a parity guard test, not
  scattered. The mock's *two* near-identical sealing `useEffect`s (mount-seal + re-verify) are
  collapsed into a single `sealBundle()` + `deriveReport()` reused by both paths.
- **SRP.** One module, one job: `sealVerify.ts` (crypto + report derivation), `demoBundle.ts`
  (data), `ProvabilityVerifier.tsx` (state orchestration), and one file per presentational
  sub-component. No file mixes hashing, data, and rendering — the mock's chief smell.
- **SoC.** Four concerns kept apart: demo data ▸ verification logic ▸ anchor simulation ▸
  presentation. The anchor simulation (rewritable vs frozen root) is the *only* demo-specific
  deviation from production semantics and is isolated in `sealVerify.ts` behind a named
  `simulateAnchor(tier)` so it is obvious and swappable (phase 2 replaces it with a real
  parsed bundle).
- **Faithful by construction.** Anything the demo asserts about a claim is computed by the
  shared `deriveReport`, never hard-coded per UI state, so the rendered verdict cannot
  contradict the rule.

## 12. Audit provenance

Every contract claim in this spec was verified against source on 2026-06-15 (file:line cited
inline). Corrections applied after that audit: (a) the local-tier `sigOk` framing — local is
`tamper-detecting` by the **rank gate**, not by lacking a signature (`LocalAnchor` stores
signatures); (b) `handoff` is `verifyBundle()`-only and `'n/a'` here; (c) docs-site has no
test harness — vitest must be added; (d) real field names substituted for the mock's
(`executor`, `secretRefs`, `resultRef`, `WorkItem.depends_on`, `AuditItemOutcome`).

## 13. Phase 2 (out of scope, recorded)

A "paste your own `bundle.json`" mode running offline verify in-browser (tamper-detecting
ceiling, no anchor). The component is built so this is an additive mode, not a rewrite:
`deriveReport` already takes a state object; phase 2 supplies it from a parsed bundle
instead of synthetic data.
