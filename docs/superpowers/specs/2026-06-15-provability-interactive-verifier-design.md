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

| Demo surface | Real concept (`audit.ts` / `audit-verify.ts`) |
|---|---|
| DAG node | a plan item / `DispatchManifest` (refs only, never secret values) |
| node `credential.scope` | the grant scope sealed into the manifest |
| node `credential.ref` (`tok_*`) | a **reference**; the secret *value* never enters the bundle |
| per-node hash | entry hash in the hash-chained lifecycle log |
| root seal | Merkle root over entry hashes |
| "External anchor" meta row | the configured `AuditAnchor` (now an interactive tier toggle) |
| verdict | `VerificationReport.claim` + `timeTier` (two axes, see §5.2) |
| checklist | `VerificationReport.checks` (`chain·root·signature·anchor·time`) |

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
Teaches: *the guarantee comes from where the root lives, not from the bundle.* This mirrors
`claimFor()` exactly — `tamper-evident` is licensed only at `external-immutable` and above,
and only with a verified signature.

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

- **On `S3 Object Lock`:** re-seal **fails** with `failure: 'root-mismatch'`. Caption:
  *"The anchored root is in a separate trust domain (WORM). The attacker rewrote the bundle
  — but not the anchor, and does not hold the signing key. That is tamper-evident."*

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
3. **signature** (`sigOk`):
   - `local` tier carries **no signature** → `sigOk = 'n/a'` (matches the default
     `LocalAnchor` report). It does not fail `intact`, but it caps the claim at
     `tamper-detecting`.
   - `s3-worm` tier: `sigOk = true` **iff** `anchoredRoot` is the honest, operator-signed
     root. The attacker cannot forge it (no signing key — see the seal-signing-key-custody
     KMS spec). Because WORM freezes `anchoredRoot` to the honest root, the actual catch on
     attacker re-seal is `root-mismatch` (recomputed ≠ frozen anchored), surfaced first.
4. **anchor**: `anchorOk` ⇔ an anchored root exists (always true here).
5. **time**: `timeAttested ? 'tsa-attested' : 'asserted'` — informational, never gates the
   claim.

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

- Add `@astrojs/react`, `react`, `react-dom`, and `lucide-react` to `docs-site`.
- Register `react()` in `astro.config.mjs` integrations.
- Component lives at `docs-site/src/components/ProvabilityVerifier.tsx` (the upgraded mock).
- New page `docs-site/src/content/docs/provability.{mdx}` renders `<ProvabilityVerifier
  client:only="react" />`, with prose framing above/below.
- Add a top-level sidebar entry **"Provability"** (near "Use cases") so it is not buried.
- Also embed the island in `explanation/audit-guarantee-tiers` at the two-claims section.
- `client:only="react"` (not `client:load`) because it depends on `crypto.subtle` and DOM
  measurement; no SSR value.

## 9. Testing

- **Unit (logic, framework-free):** extract the verify-derivation into a pure function
  `deriveReport(state)` and test it directly:
  - clean + local → `tamper-detecting`, `sigOk:'n/a'`, `intact:true`.
  - clean + s3-worm → `tamper-evident`, `sigOk:true`.
  - clean + s3-worm + timeAttested → still `tamper-evident`, `timeTier:'tsa-attested'`
    (orthogonality).
  - tamper, no reseal → `intact:false`, `failure:'chain'`.
  - tamper + reseal + local → `intact:true`, `tamper-detecting` (attacker wins).
  - tamper + reseal + s3-worm → `intact:false`, `failure:'root-mismatch'` (attacker caught).
- **Build:** `astro build` succeeds with the React integration; the page renders.
- **Visual smoke:** the three interactions behave as specified in a real browser (real
  SHA-256, ripple, captions).
- A guard assertion that the demo's `claimFor` matches the real one's truth table (copy the
  table into the test) so the demo can never drift into overclaiming.

## 10. Honesty constraints (inherited, non-negotiable)

The demo obeys the same vocabulary discipline as the product:
- "tamper-evident" rendered **only** at `external-immutable`+ with a verified signature.
- `LocalAnchor` is **never** labelled tamper-evident or compliant.
- Copy says "compliance-ready," never "compliant" / "certified" / "reproducible."
- The time axis is shown separately and never silently upgrades the tamper claim.

## 11. Phase 2 (out of scope, recorded)

A "paste your own `bundle.json`" mode running offline verify in-browser (tamper-detecting
ceiling, no anchor). The component is built so this is an additive mode, not a rewrite:
`deriveReport` already takes a state object; phase 2 supplies it from a parsed bundle
instead of synthetic data.
