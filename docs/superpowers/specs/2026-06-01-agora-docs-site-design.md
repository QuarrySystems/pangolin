---
title: Agora Documentation Site — Architecture & Structure Spec
date: 2026-06-01
status: **SHIPPED — status corrected 2026-08-03.** Verified on main: `docs-site/ (deployed by the Deploy docs site workflow)`. This line previously read "draft", which was stale: the work landed and the marker was never updated. **Originally:** draft
branch: docs/agora-docs-site-spec
authors: [human:Brett, agent:claude-opus-4-8]
builds_on: "[[docs/superpowers/specs/2026-05-29-agora-offload-v1-design.md]]"
---

# Agora Documentation Site — Architecture & Structure Spec

> **Status:** DRAFT. This is a documentation-architecture spec, not a code spec.
> It defines how the existing prose docs (10 guides, 17 ADRs, 4 examples, 3
> design specs) are restructured into a published documentation site for the
> source-available (BSL 1.1) public release. The product is unchanged; only its
> documentation surface is.

---

## 0. Why this spec exists

agora is going public under the Business Source License 1.1. The codebase is
mature and the *content* of its documentation is already strong — but the
content is delivered as a flat `docs/` folder that mixes tutorials, reference,
and explanation into one undifferentiated list. A stranger arriving from the
public repo has no guided path and no sense of which kind of page they're
reading.

This spec defines a **published documentation site** that imposes a model on
the existing content so that:

1. A new reader can self-serve from "what is this?" to "first dispatch" to
   "running an offload DAG in production" without a human in the loop.
2. The site *sells* on agora's differentiator (offload: DAG fan-out under
   file-locks, reviewable patches, tamper-evident audit) while *teaching* from
   the necessary foundation (single dispatch).
3. Every page has an obvious type, so the docs resist rotting back into a pile.

This is overwhelmingly a **restructure + reframe**, not an authoring effort.
The content-mapping table in §4 shows that all but three pages already exist.

## 1. Decisions locked in brainstorming

| # | Decision | Rationale |
|---|---|---|
| DS1 | **Published docs site**, not elevated in-repo markdown. | Highest-polish impression for an open release; built-in search, versioning, nav. |
| DS2 | **Astro Starlight** as the generator. | Markdown/MDX-first (content ports near-verbatim), TypeScript-native (matches stack, low contributor friction), built-in search + versioning + sidebar, renders Mermaid (the README arch diagram already uses it). VitePress is the runner-up; Docusaurus is heavier than needed; Mintlify is hosted SaaS — an odd fit for source-available. |
| DS3 | **Diátaxis** as the organizing spine (Tutorials / How-to / Reference / Explanation), with an **audience router** on the landing page. | Diátaxis separates page *kinds* so "sell" pages and "teach" pages don't bleed together. The router gives each persona a one-click entry. |
| DS4 | **Audience priority: integrators-funnel, operators-headline.** Lead the tutorial track at integrators (single dispatch — the vocabulary); make offload the landing-page hero (the differentiator). | You can't teach `agora orch submit` cold; dispatch is the vocabulary, offload is the sentence. Resolves the integrator-vs-operator fork by sequencing rather than choosing. |
| DS5 | **New `docs-site/` directory in this repo**, sourcing from a restructured `docs/` content tree. | Docs versioned with code; one PR updates both atomically; no cross-repo drift. |

## 2. Audiences

The landing-page router targets four personas. Every page declares which it
serves (sidebar grouping makes this visible).

| Persona | Wants | Entry point | Primary track |
|---|---|---|---|
| **Integrator** (SDK caller) | Wire `AgoraClient` into an app: register, dispatch, read results. | "Dispatch one agent" | Tutorials → How-to |
| **Operator** (offload) | Run `agora orch` DAGs unattended; patches + audit. | "Orchestrate a DAG" | Tutorials (graduate step) → How-to → Explanation |
| **Extender** (provider author) | Implement a compute/storage/credential/sink seam. | "Extend a provider" | How-to → Reference |
| **Evaluator** | Decide whether to adopt: what is it, is it safe, what does BSL mean. | "Evaluate / is it safe?" | Explanation |

## 3. Site structure

The landing page does the hero (sells offload) plus a four-way audience router.
Everything below it is organized by the four Diátaxis modes.

```
docs-site/
├─ index            Hero (sells offload) + audience router:
│                    "Dispatch one agent" · "Orchestrate a DAG" ·
│                    "Extend a provider" · "Evaluate / is it safe?"
│
├─ Tutorials          (learning — hold-your-hand, one happy path, no choices)
│   ├─ Your first dispatch
│   └─ Your first offload run           (the graduate step)
│
├─ How-to guides      (task — "I need to X", numbered steps, assumes basics)
│   ├─ Put files where the worker finds them
│   ├─ Sync capabilities & subagents
│   ├─ Handle a needs_input pause
│   ├─ Dispatch to a remote Docker daemon
│   ├─ Deploy to Fargate + S3 (production)        [NEW]
│   ├─ Export & verify an audit bundle             [NEW]
│   └─ Write a provider
│
├─ Reference          (information — dry, lookup-oriented, generated where possible)
│   ├─ CLI: agora & agora orch
│   ├─ MCP tools (the six run-time tools)
│   ├─ AgoraClient API
│   ├─ agora.config.{ts,js,mjs}
│   ├─ Dispatch lifecycle events & failure reasons
│   ├─ plan.json schema
│   └─ Package map (the 13)
│
└─ Explanation        (understanding — the "why", couch-reading)
    ├─ Architecture overview
    ├─ Sandboxing AI agents
    ├─ Audit & guarantee tiers                     [NEW]
    ├─ The privilege boundary (§10.6)
    ├─ Licensing & BSL — what it means for you
    └─ Decision records (the 17 ADRs)
```

### 3.1 Navigation model

- **Sidebar** groups by Diátaxis mode (Tutorials / How-to / Reference /
  Explanation), in that order — the canonical Diátaxis reading order.
- **Landing router** cuts across the sidebar by persona, so an operator lands
  on the offload tutorial directly without scanning four groups.
- **Cross-links**: every tutorial ends with "next steps" pointing at the
  relevant how-to and explanation pages. Every how-to links its reference
  pages. This is the connective tissue that a flat folder lacks.

## 4. Content mapping (existing → site)

Almost everything slots in. `[PORT]` = move + reframe to its Diátaxis voice;
`[NEW]` = net-new authoring; `[SPLIT]` = one source feeds multiple pages.

| Site page | Mode | Source | Action |
|---|---|---|---|
| Your first dispatch | Tutorial | `getting-started.md` + `examples/hello-world/` | PORT (reframe runbook → guided tutorial) |
| Your first offload run | Tutorial | `examples/offload-fanout/` + `offload-orchestration.md` | SPLIT/PORT (tutorial voice; deep ref goes to Reference) |
| Put files where the worker finds them | How-to | `capability-recipes.md` | PORT |
| Sync capabilities & subagents | How-to | `sync-providers.md` | PORT |
| Handle a needs_input pause | How-to | `needs-input.md` | PORT |
| Dispatch to a remote Docker daemon | How-to | `remote-dispatch-windows.md` | PORT (degeneralize from Windows-only title) |
| Deploy to Fargate + S3 (production) | How-to | offload V1 spec + MVP spec (Fargate parity) | **NEW** |
| Export & verify an audit bundle | How-to | `offload-orchestration.md` (audit section) | **NEW** (extract + expand) |
| Write a provider | How-to | `writing-a-provider.md` | PORT |
| CLI reference | Reference | CLI `--help` + `offload-orchestration.md` | PORT/generate |
| MCP tools | Reference | `agora-mcp` package | PORT |
| AgoraClient API | Reference | `agora-client` package | PORT/generate |
| agora.config | Reference | getting-started + examples | PORT |
| Dispatch lifecycle events | Reference | `dispatch-lifecycle.md` | PORT |
| plan.json schema | Reference | `examples/offload-fanout/plan.json` + spec | PORT |
| Package map | Reference | README "What's in this repo" table | PORT |
| Architecture overview | Explanation | `architecture-overview.md` | PORT |
| Sandboxing AI agents | Explanation | `sandboxing-ai-agents.md` | PORT |
| Audit & guarantee tiers | Explanation | offload V1 spec (tiers section) | **NEW** (extract + expand) |
| The privilege boundary | Explanation | ADR-0005 + spec §10.6 | PORT |
| Licensing & BSL | Explanation | `LICENSING.md` + ADR-0017 | PORT |
| Decision records | Explanation | `docs/decisions/*` (17 ADRs) | PORT (index + render) |

**Net-new authoring is three pages:** Deploy to Fargate + S3, Export & verify
an audit bundle, Audit & guarantee tiers. Everything else is reframing.

## 5. Repository layout

```
agora/
├─ docs/                         # content tree (markdown), Diátaxis folders
│   ├─ tutorials/
│   ├─ how-to/
│   ├─ reference/
│   ├─ explanation/
│   └─ decisions/                # existing ADRs stay here, indexed under Explanation
├─ docs-site/                    # Astro Starlight project
│   ├─ astro.config.mjs          # sidebar, Mermaid, search config
│   ├─ src/content/docs/         # Starlight reads markdown (symlink or src dir → docs/)
│   └─ package.json              # site build deps, isolated from workspace runtime deps
└─ docs/superpowers/specs/       # design specs (this file) — unchanged
```

- `docs-site/` is **not** a workspace package (excluded from
  `pnpm-workspace.yaml` runtime globs) so its Astro deps never leak into the
  published `@quarry-systems/*` package graph. The agora-core "no external
  Quarry deps" CI allowlist is unaffected.
- The existing `docs/superpowers/specs/` design canon is **not** part of the
  published site — specs are an internal artifact; Explanation pages link to
  them for readers who want the full design record.

## 6. Build & deploy

- **Build:** `pnpm --filter docs-site build` produces a static site.
- **Deploy:** GitHub Pages via a `.github/workflows/docs.yml` action on push to
  `main` that touches `docs/**` or `docs-site/**`. (Hosting choice — Pages vs
  Netlify/Cloudflare Pages — is an implementation-plan decision, not locked
  here; Pages is the zero-extra-account default.)
- **Versioning:** Starlight's built-in versioning, seeded with the current
  release. Deferred until after first publish — v1 ships unversioned.

## 7. Scope boundaries

**In scope:** site scaffold, Diátaxis restructure of existing content, the
audience router landing page, the three new pages (§4), cross-linking, a deploy
workflow.

**Out of scope (explicitly deferred):**

- Auto-generated API reference from TypeScript types (TypeDoc integration) —
  v1 reference pages are hand-written/ported. Revisit once the site is live.
- Versioned docs — ship unversioned first.
- Search beyond Starlight's built-in (no Algolia).
- Internationalization.
- Moving the design specs into the published site.

## 8. Success criteria

1. A reader landing on the site index can reach a successful first dispatch by
   following one linked path, with no need to read the repo source.
2. Every published page is unambiguously one Diátaxis mode (verified in
   self-review against the Diátaxis test: tutorial=learning, how-to=task,
   reference=lookup, explanation=understanding).
3. The offload differentiator is the first thing an evaluator sees.
4. `pnpm --filter docs-site build` succeeds in CI and deploys on merge to main.
5. No Astro/site dependency appears in any published `@quarry-systems/*`
   package's dependency tree.

## 9. Open questions for implementation planning

- **Content source wiring:** symlink `docs/` into `docs-site/src/content/docs/`,
  or configure Starlight's `srcDir` to point at `docs/` directly? (Windows
  symlink friction suggests the latter.)
- **ADR rendering:** index the 17 ADRs as a single Explanation collection page,
  or one sidebar entry per ADR? (Leaning: one collection page + per-ADR routes.)
- **Hosting:** GitHub Pages vs Cloudflare Pages — decide in the plan.
