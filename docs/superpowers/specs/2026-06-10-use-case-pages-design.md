# Use-case pages for the docs site — design

**Date:** 2026-06-10
**Status:** Approved (brainstormed with operator)
**Scope:** `docs-site/` only — four new content pages, one sidebar section, one homepage row.

## Goal

Add a prospect-facing "Use cases" layer to the docs site (Astro Starlight, Diátaxis-shaped) that routes by *audience problem* rather than by *task* — and is verifiably accurate to the implementation as it exists on `main`/this branch. Pages double as outreach collateral for the GTM motion (20-person named outreach; ICP = seed–Series-A vertical-agent builders in regulated domains with a stalled deal on "where does it run / prove what it did").

## Non-goals

- No changes to existing pages other than `index.mdx` (homepage card row) and `astro.config.mjs` (sidebar).
- No claims about authorization/Bedrock binding beyond an explicit roadmap mention — the "…and that it was allowed to" half of the hook is direction, not shipped.
- No customer names, testimonials, or fabricated metrics.
- No new examples, code, or CLI changes. Docs only.

## The four pages

All live at `docs-site/src/content/docs/use-cases/`. Each page anchors to exactly **one runnable example directory** (or shipped CLI surface) that proves it — that anchor is the accuracy contract.

| File | Working title / hook | Anchor (verified) |
|---|---|---|
| `regulated-document-drafting.md` | Draft regulated documents in batch — and prove what ran. Opens on the stalled-deal pain. | `examples/demo-claims-appeals` — 3-claim fan-out under per-claim `resourceLocks`, self-verify command sealed in the manifest (`verify` field), audit bundle assembly, forge-one-byte verification failure |
| `dev-offload.md` | Stop melting your laptop — fan codebase maintenance out to parallel sandboxed agents, get reviewable patches back. | `examples/offload-fanout` (plan.json DAG, locks, patch escape) + `examples/pattern-dogfood` (gated circle-back) |
| `compliance-evidence.md` | Hand your customer's auditor evidence they can verify **without trusting you**. | `pangolin verify` CLI (`packages/pangolin-cli/src/cmd-verify.ts`), the five verification checks (chain / root / signature / anchor / handoff closure), `LocalAnchor` vs `S3ObjectLockAnchor` guarantee tiers |
| `data-pipelines.md` | The same provable substrate, no LLM in the loop. | `examples/data-mapreduce` (fully offline, no API key, identical audit chain) |

## Uniform page anatomy

Every page follows the same six-section skeleton. The accuracy discipline lives in this template.

1. **The pain** — 2–3 sentences in the ICP's voice. Problem-first GTM tone (approved); persuasive opening only here, factual body after.
2. **What you get** — outcome bullets plus one real terminal excerpt. Excerpts are taken from the example's verified output or the render code (`packages/pangolin-orchestrator/src/view/render.ts`, `src/audit/render.ts`) — never invented.
3. **How it works** — numbered steps mapping to real commands and package names. Link existing reference/explanation pages (`explanation/audit-guarantee-tiers`, `explanation/how-offload-runs`, `reference/cli`, `how-to/verify-audit-bundle`) rather than restating them.
4. **Run it yourself** — exact commands a fresh-machine prospect can execute, **including the local worker-image build step** (`docker build -f docker/pangolin-worker/Dockerfile -t ghcr.io/quarrysystems/pangolin-worker:latest .`) — the GHCR image is not anonymously pullable, and this bakes that audit finding's fix into every page.
5. **Shipped today vs. on the roadmap** — a Starlight `:::note` (or `:::caution` where the distinction is load-bearing) aside drawing the honest line:
   - Tamper-**detecting** by default (`LocalAnchor`, root in SQLite, guarantee `detect`); tamper-**evident** only at the external-immutable tier (`S3ObjectLockAnchor`, WORM/COMPLIANCE mode).
   - Independent third-party verification requires the external-immutable tier — at the local tier, verification needs access to the producer's anchor.
   - "…and that it was allowed to" (authorization binding), RFC 3161 timestamping, and compliance-evidence tooling are roadmap items. Roadmap claims are sourced from `ROADMAP.md` / `explanation/project-status-roadmap` **only**.
6. **Next steps** — links into the matching tutorial / how-to.

## Site wiring

- **`docs-site/astro.config.mjs`** — new sidebar section labelled **Use cases**, placed **above Tutorials** (a prospect arriving from outreach hits "is this for me?" before "lesson one"). Four explicit slugs in the table's order.
- **`docs-site/src/content/docs/index.mdx`** — a new "Who is it for?" `CardGrid` row with one card per use case, placed **above** the existing "What do you want to do?" grid (same logic as the sidebar: audience routing before task routing; the existing grid is untouched).

## Accuracy & verification contract

- Every command, flag, output block, package name, and behavioral claim on a page must be traceable to a file **read during writing** — no memory-based claims. When in doubt, open the example's `package.json` / `README.md` / source.
- Known truth constraints (from the 2026-06-10 audit) that pages must respect:
  - The multi-process CLI flow (`pangolin orch serve` / `submit` / `audit` as separate processes) is **not** runnable end-to-end (blocked on a `deploy` registration step) — pages must show the single-process example flow (`pnpm start` / `start:env`) and may mention the operator flow only as roadmap.
  - The demo's claim fixtures are synthetic and PHI-free; say so where claim data appears.
  - `pangolin verify` requires a `pangolin.config` with an anchor; verification is independent only at the S3 Object Lock tier.
- **Build gate:** `docs-site` must build clean — the `starlight-links-validator` plugin (errorOnRelativeLinks, errorOnInvalidHashes) catches broken cross-links introduced by the new pages.

## Testing

- `pnpm` build of `docs-site` passes (links validated).
- Manual read-through of each page against its anchor example directory (section-4 commands copy-paste runnable from repo root).

## Risks

- **Drift:** use-case pages restate behavior that examples/READMEs also state; mitigated by linking instead of restating wherever an existing page covers the ground, and by the one-anchor-per-page rule.
- **Tone:** problem-first openings must not slide into claims the honesty asides then contradict; the section-5 aside is mandatory on every page.
