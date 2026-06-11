# Use-Case Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four prospect-facing use-case pages to the Starlight docs site, wired into a new top-level sidebar section and a homepage card row — every claim traceable to a verified repo surface.

**Architecture:** Four standalone `.md` content pages under `docs-site/src/content/docs/use-cases/`, each following the spec's six-section anatomy and anchored to exactly one runnable example. Site wiring (sidebar + homepage) lands after the pages exist so the links validator passes at every commit. A final audit task enforces vocabulary discipline, DRY (link-don't-restate), and repo conventions.

**Tech Stack:** Astro 6 + Starlight 0.39 (markdown content collections, `:::note` / `:::caution` aside directives, `starlight-links-validator` with `errorOnRelativeLinks: true` — all internal links MUST be absolute `/pangolin/...` paths).

**Spec:** `docs/superpowers/specs/2026-06-10-use-case-pages-design.md`

**Verification command (used in every task):**
```sh
pnpm --filter @pangolin-scale/docs-site build
```
Expected: build completes, exit 0, no links-validator errors.

**Ground-truth sources already verified for this plan** (the engineer does NOT need to re-derive these, but may consult them):
- `examples/demo-claims-appeals/README.md` + `package.json` (scripts `start:env`, `test`; filter name `demo-claims-appeals-example`; worker image `ghcr.io/quarrysystems/pangolin-worker:latest` hardcoded at `src/index.ts:47`)
- `examples/offload-fanout/README.md` (filter `offload-fanout-example`, scripts `start`, `start:env`, `test`)
- `examples/pattern-dogfood/README.md` (filter `pattern-dogfood-example`, zero-credit in-memory fake executor, `run.extended` spawn entries)
- `examples/data-mapreduce/README.md` (filter `data-mapreduce-example`, fully offline, **InprocWorkerExecutor test-fixture caveat**, expected sum=100 output)
- `docs-site/src/content/docs/explanation/audit-guarantee-tiers.md` (tier semantics, honesty constraints, "compliance-ready never compliant")
- `docs-site/src/content/docs/how-to/verify-audit-bundle.mdx` (verify CLI flags `--json`/`--full`, live-anchor caveat, sample outputs)
- `ROADMAP.md` (V1 shipped surface; known gap: Fargate+S3 not maintainer-verified end-to-end, no concrete `S3LockClient` adapter ships; `witnessed`/RFC 3161 tier reserved; `Authorizer` seam is V1.1)
- `docker/pangolin-worker/Dockerfile` and root `.env.example` exist.

---

### Task 1: Page — regulated document drafting

**Files:**
- Create: `docs-site/src/content/docs/use-cases/regulated-document-drafting.md`

- [ ] **Step 1: Create the page with exactly this content**

```markdown
---
title: "Use case: regulated document drafting"
description: Batch-draft regulated documents — claims appeals, filings, reconciliations — with parallel sandboxed agents, and hand over a verifiable audit bundle of exactly what ran.
---

You build an agent product for a regulated vertical — healthcare, insurance,
legal, finance. The agent works. The deal stalls anyway, on two questions your
hosted stack can't answer: **where does it run** (their data can't leave) and
**can you prove what it did** (their auditor won't take a dashboard's word for
it). Pangolin Scale is the execution substrate that answers both: self-hosted,
sandboxed, and sealing a verifiable record of every run.

## What you get

The shipped demo for this use case is
[`examples/demo-claims-appeals`](https://github.com/quarrysystems/pangolin/tree/main/examples/demo-claims-appeals):
a batch of three denied insurance claims fans out to parallel agents that each
draft an appeal, self-verify their own work, and seal the evidence.

- **Safe fan-out** — three `claim-appeal` items run concurrently (concurrency 2),
  each under a per-output `resourceLock`, so parallel drafts never collide.
- **Patch escape** — each drafted appeal surfaces as a content-addressed
  `resultRef` (the workspace diff), never stored in the run-state database.
- **Self-verify, sealed with the patch** — each agent runs a shell check over its
  own edit (`appeals/*.md` exists and cites a policy section) before its patch
  escapes; the pass/fail is sealed into the dispatch manifest.
- **A verifiable audit bundle** — after all items are terminal, the run seals a
  hash-chained, Merkle-rooted log and the bundle report prints:

```text
=== Audit bundle ===
  intact:    true
  claim:     tamper-detecting
  anchorId:  local
  guarantee: detect
```

Forge one byte of the exported bundle and verification fails with a non-zero
exit code — that is the demo's closing beat.

## How it works

1. `plan.json` declares three `claim-appeal` items plus a `verify` gate that
   depends on all three. The orchestrator resolves dependencies, locks, and
   concurrency — see [How an offload run executes](/pangolin/explanation/how-offload-runs/).
2. Each item dispatches into an isolated Docker container. The agent reads one
   synthetic claim fixture (`claimId`, `denialReason`, `policySection`, …) and
   drafts `appeals/<claimId>.md` in its own workspace.
3. Before the patch escapes, the item's self-verify command runs inside the
   worker; its result is sealed into the manifest alongside the patch.
4. On completion the run seals its epoch: every lifecycle event is hash-chained,
   the chain is reduced to a Merkle root, and the root is signed and anchored —
   see [Audit & guarantee tiers](/pangolin/explanation/audit-guarantee-tiers/).
5. `pangolin verify` re-verifies the exported bundle — see
   [Export & verify an audit bundle](/pangolin/how-to/verify-audit-bundle/).

The claims domain is a reskin, not a special case: swap the fixtures and the
`claim-appeal` prompt to draft legal filings, reconciliations, or procurement
documents — the proof beats are identical.

## Run it yourself

Requires Node 20+, pnpm, Docker, and an Anthropic API key. The worker image is
not anonymously pullable, so build it locally first:

```sh
# from the repo root
pnpm install
docker build -f docker/pangolin-worker/Dockerfile -t ghcr.io/quarrysystems/pangolin-worker:latest .
cp .env.example .env       # then set ANTHROPIC_API_KEY in .env
pnpm --filter demo-claims-appeals-example start:env
```

No Docker or API key handy? The CI smoke test drives the same plan through a
fake executor and asserts the bundle verifies:

```sh
pnpm --filter demo-claims-appeals-example test
```

:::caution[Shipped today vs. on the roadmap]
- The demo's default anchor is `LocalAnchor`, so its honest claim is
  **tamper-detecting** — the root lives in the same store as the log. The
  **tamper-evident** claim requires the `external-immutable` tier
  (`S3ObjectLockAnchor`); see
  [Audit & guarantee tiers](/pangolin/explanation/audit-guarantee-tiers/).
- The claim fixtures are **synthetic** — no real PHI anywhere in the example.
- The canonical run is the single-process driver shown above. The multi-process
  CLI flow (`pangolin orch serve` / `submit` / `audit` as separate processes)
  is not yet runnable for this example — it needs a registration/deploy step
  that has not shipped.
- Pangolin Scale's vocabulary is **"compliance-ready," never "compliant" or
  "certified."** The audit trail proves what ran and what it produced — not
  that the output is correct.
:::

## Next steps

- [Your first offload run](/pangolin/tutorials/first-offload-run/) — the tutorial behind this demo.
- [Export & verify an audit bundle](/pangolin/how-to/verify-audit-bundle/) — produce and re-verify the evidence.
- [Commercial & pilots](/pangolin/commercial/) — white-glove pilot for your regulated deal.
```

- [ ] **Step 2: Vocabulary discipline check**

Run from repo root:
```sh
grep -niE '\b(compliant|certified|guaranteed)\b' docs-site/src/content/docs/use-cases/regulated-document-drafting.md
```
Expected: matches ONLY inside the honesty aside where the words are explicitly negated (`never "compliant" or "certified"`). Any other match is a violation — fix before committing.

- [ ] **Step 3: Build the docs site**

Run: `pnpm --filter @pangolin-scale/docs-site build`
Expected: exit 0, no links-validator errors. (The page is not in the sidebar yet — that is Task 5 and is fine.)

- [ ] **Step 4: Commit**

```sh
git add docs-site/src/content/docs/use-cases/regulated-document-drafting.md
git commit -m "docs(use-cases): regulated document drafting page"
```

---

### Task 2: Page — dev offload

**Files:**
- Create: `docs-site/src/content/docs/use-cases/dev-offload.md`

- [ ] **Step 1: Create the page with exactly this content**

```markdown
---
title: "Use case: dev offload"
description: Fan codebase maintenance out to parallel sandboxed agents and get back reviewable patches — with an audit trail of exactly what ran while you weren't watching.
---

Running coding agents locally pegs your CPU and ties the work to your laptop's
uptime; running them unattended means trusting output you didn't watch get
made. Pangolin Scale offloads the work to isolated containers, fans it out
safely in parallel, and hands back **a reviewable patch per task** — plus a
sealed record of what ran, so "unattended" stops meaning "unaccountable."

## What you get

The acceptance demo for this use case is
[`examples/offload-fanout`](https://github.com/quarrysystems/pangolin/tree/main/examples/offload-fanout):
three independent code edits fan out across Docker workers, then a verify gate
checks the result.

- **Safe parallelism** — each `code-edit` item holds a per-file `resourceLock`;
  two items that touch the same file serialize automatically instead of racing.
- **Reviewable patches** — each worker's output is its workspace diff, escaped
  as a content-addressed `resultRef`. You review the patch before anything
  touches your repo; nothing auto-merges.
- **Retry / backoff** — failed items retry with exponential backoff up to
  `maxAttempts`; exhausted items go `failed` and their dependents are skipped,
  all of it recorded in the audit log.
- **The sealed record** — the run ends with the same verifiable audit bundle as
  every other domain:

```text
=== Audit bundle ===
  intact:    true
  claim:     tamper-detecting
  anchorId:  local
  guarantee: detect
```

## Gated circle-back: when review fails, the run fixes itself — on the record

[`examples/pattern-dogfood`](https://github.com/quarrysystems/pangolin/tree/main/examples/pattern-dogfood)
shows the `pipeline` pattern's spawn-fix gate. When a `review` gate completes
**done-but-red** (its verify check failed), the pattern appends a fix item, a
re-review, and a re-run of the downstream task via the audited `extendRun`
seam. The original red review and the skipped downstream item are preserved as
sealed history — the run is never rewound, only extended with a forward arc.
Every spawn writes a `run.extended` audit entry naming which gate fired and
that the actor was the pattern layer, and provenance closure is checked across
the grown graph. See
[Execution patterns](/pangolin/explanation/execution-patterns/) and
[Typed-product handoff](/pangolin/explanation/typed-product-handoff/).

## Run it yourself

The live fan-out (real Docker workers, real agents) — requires Node 20+, pnpm,
Docker, and an Anthropic API key, with the worker image built locally first:

```sh
# from the repo root
pnpm install
docker build -f docker/pangolin-worker/Dockerfile -t ghcr.io/quarrysystems/pangolin-worker:latest .
cp .env.example .env       # then set ANTHROPIC_API_KEY in .env
pnpm --filter offload-fanout-example start:env
```

The gated circle-back demo runs offline — no Docker, no API key:

```sh
pnpm --filter pattern-dogfood-example start
```

:::note[What each demo proves]
`offload-fanout`'s live path dispatches real agents in real containers.
`pattern-dogfood` runs a **deterministic in-memory fake executor** — no
containers, no LLM — so it proves the engine's circle-back, audit, and
provenance semantics, not live agent behavior. The default audit tier in both
is **tamper-detecting** (`LocalAnchor`); see
[Audit & guarantee tiers](/pangolin/explanation/audit-guarantee-tiers/).
:::

## Next steps

- [Your first offload run](/pangolin/tutorials/first-offload-run/) — submit your own plan.
- [How an offload run executes](/pangolin/explanation/how-offload-runs/) — queues, deps, locks, audit.
- [Sandboxing AI agents](/pangolin/explanation/sandboxing-ai-agents/) — the isolation model.
```

- [ ] **Step 2: Vocabulary discipline check**

Run: `grep -niE '\b(compliant|certified|guaranteed|tamper-evident)\b' docs-site/src/content/docs/use-cases/dev-offload.md`
Expected: **no matches** (this page has no business making tier claims beyond tamper-detecting).

- [ ] **Step 3: Build the docs site**

Run: `pnpm --filter @pangolin-scale/docs-site build`
Expected: exit 0, no links-validator errors.

- [ ] **Step 4: Commit**

```sh
git add docs-site/src/content/docs/use-cases/dev-offload.md
git commit -m "docs(use-cases): dev offload page"
```

---

### Task 3: Page — compliance evidence

**Files:**
- Create: `docs-site/src/content/docs/use-cases/compliance-evidence.md`

- [ ] **Step 1: Create the page with exactly this content**

```markdown
---
title: "Use case: compliance evidence"
description: Export a sealed evidence bundle for every agent run and let an auditor re-verify it with one command — with the guarantee tier stated honestly.
---

Your customer's auditor asks what your AI agents actually did. Screenshots of
a dashboard don't survive that conversation — the evidence has to be
verifiable by someone who does not trust you, on tooling you don't control.
Pangolin Scale seals every run into an exportable bundle whose verification
**recomputes everything** rather than trusting a stored verdict.

## What you get

- **An exportable evidence bundle** per run: the per-item dispatch manifests
  (references only — secret values never appear), the hash-chained lifecycle
  log, the signed and anchored Merkle root, and a verification report.
- **One-command re-verification** — `pangolin verify bundle.json` replays the
  hash chain, recomputes the Merkle root, fetches the anchored root from the
  live anchor, checks the signature, and checks provenance closure (every
  consumed input ref must be the sealed product of a completed item in the
  same run). On a clean bundle:

```text
  pangolin verify  ·  run_a3f9c2                  ✓ TAMPER-EVIDENT
  ──────────────────────────────────────────────────────────
  ✓ chain        10 entries, hash-linked, no gaps
  ✓ root         merkle c4f1a9…  =  anchored root
  ✓ signature    ed25519 / pangolin-prod  valid
  ✓ anchor       s3:my-audit-bucket  (external-immutable)
```

- **CI-gateable exit codes** — a bundle that fails any check exits non-zero,
  so verification can gate a pipeline or an incident review. `--json` emits
  the raw report; `--full` prints every ledger row.

## How the guarantee stays honest

The report's `claim` field is derived, never asserted. **`tamper-evident` is
licensed only when the anchor tier is `external-immutable` or higher and every
check passed** — any failure, including an unreachable anchor, collapses the
claim to `tamper-detecting`. The default `LocalAnchor` stores the root in the
same store as the log, so it can never earn more than tamper-detecting; the
`S3ObjectLockAnchor` writes the root to S3 Object Lock in COMPLIANCE mode — a
separate trust domain that survives a database-side rewrite. The full model,
including what each tier does **not** guarantee, is in
[Audit & guarantee tiers](/pangolin/explanation/audit-guarantee-tiers/).

## Independent verification — what the auditor needs

`pangolin verify` is deliberately **not** a pure function of the bundle file:
it fetches the anchored root from the live anchor, never the copy embedded in
the bundle (a bundle carrying its own trusted root would let a tamperer
rewrite the log and the root together). An independent auditor therefore
needs two things:

1. The bundle file.
2. Read access to the anchor that sealed the run — for the
   `external-immutable` tier, the S3 Object Lock location.

For programmatic use, the same check is the `verifyBundle(bundle, { anchor })`
entry point exported from `@quarry-systems/pangolin-orchestrator`, so an
auditor can re-verify inside their own tooling. The step-by-step flow is in
[Export & verify an audit bundle](/pangolin/how-to/verify-audit-bundle/).

## Run it yourself

Any example run ends by assembling and printing the bundle report. The
fastest offline path (no Docker, no API key) drives a real orchestrator with a
fake executor and asserts the bundle verifies:

```sh
pnpm install
pnpm --filter demo-claims-appeals-example test
```

:::caution[Shipped today vs. on the roadmap]
- `S3ObjectLockAnchor` ships, but **no concrete `S3LockClient` adapter ships
  with it** — the interface is provided and you implement the client. The
  maintainers have not run the full Fargate + S3 path end-to-end; treat
  [Deploy to Fargate + S3](/pangolin/how-to/deploy-fargate-s3/) as a
  first-run guide, not a tested recipe.
- The `witnessed` tier (a cross-organization witness such as an RFC 3161
  timestamp authority or transparency log) is **reserved in the type system
  and not implemented** — the highest claim a real deployment can earn today
  is `tamper-evident` via `external-immutable`.
- Authorization is recorded, not enforced: every operation carries an actor
  identity, but the `Authorizer` policy seam is roadmap. Today's model is
  single-operator.
- The vocabulary is **"compliance-ready," never "compliant" or "certified."**
  No tier proves the *content* of the work was correct — the trail proves what
  ran and what it produced, by reference.
:::

## Next steps

- [Audit & guarantee tiers](/pangolin/explanation/audit-guarantee-tiers/) — the full trust model.
- [Export & verify an audit bundle](/pangolin/how-to/verify-audit-bundle/) — the hands-on flow.
- [Commercial & pilots](/pangolin/commercial/) — enterprise compliance modules and pilots.
```

- [ ] **Step 2: Vocabulary discipline check**

Run: `grep -niE '\b(compliant|certified)\b' docs-site/src/content/docs/use-cases/compliance-evidence.md`
Expected: matches ONLY in the negated honesty-aside sentence. Then confirm every occurrence of `tamper-evident` on the page is tier-qualified (adjacent to `external-immutable` / S3 Object Lock context or inside the verified sample output) — fix any bare use.

- [ ] **Step 3: Build the docs site**

Run: `pnpm --filter @pangolin-scale/docs-site build`
Expected: exit 0, no links-validator errors.

- [ ] **Step 4: Commit**

```sh
git add docs-site/src/content/docs/use-cases/compliance-evidence.md
git commit -m "docs(use-cases): compliance evidence page"
```

---

### Task 4: Page — data pipelines

**Files:**
- Create: `docs-site/src/content/docs/use-cases/data-pipelines.md`

- [ ] **Step 1: Create the page with exactly this content**

```markdown
---
title: "Use case: data pipelines"
description: Run non-LLM batch data jobs on the same engine — typed handoffs, runtime fan-out, and the identical provenance-checked audit chain. Fully offline demo.
---

If your agent runs deserve provable execution, so do the batch jobs around
them — and nobody wants a second orchestrator with a second audit story.
Pangolin Scale's engine is domain-general: the same queues, dependency
resolution, typed handoffs, and sealed audit chain that run coding agents also
run plain data pipelines, with **zero engine changes**.

## What you get

The proof is
[`examples/data-mapreduce`](https://github.com/quarrysystems/pangolin/tree/main/examples/data-mapreduce)
— a map-reduce over CSV data that is **fully offline**: no Docker, no API key,
no network.

- **Runtime fan-out** — two items are submitted (`seed`, `split`); the
  `mapReduce` pattern spawns one map item per data partition at runtime, plus
  a reduce. The graph grows from 2 to 5 items, every spawn audited.
- **Typed handoffs** — each stage consumes its upstream's output via `needs`,
  materialized into the worker at `inputs/<key>` and sealed into the manifest
  as content-addressed `inputRefs`.
- **Per-block evidence** — each item's pipeline records `blocks[]` entries
  (script and capture steps with status), sealed with the run.
- **The same provenance-checked bundle** — verification confirms every
  consumed input ref is accounted for by a sealed producer:

```text
=== verifyBundle report ===
  intact:           true
  checks.handoff:   {"ok":true,"detail":"5 input refs accounted for"}

=== data-mapreduce OK — graph grew at runtime (5 items); aggregate sum=100; provenance intact ===
```

## How it works

1. `seed` writes a small CSV; `split` groups it by key and writes one file per
   group. The `mapReduce` config on `split` makes the engine spawn one
   `map-<key>` item per output file.
2. Each map item sums its partition; `reduce` receives all map results and
   totals them (expected: 100).
3. The pipeline steps are declared typed blocks from the `data` pack
   (`data.split` / `data.transform` / `data.aggregate`) — the second domain
   pack on the unchanged engine. See
   [Execution patterns](/pangolin/explanation/execution-patterns/) and
   [Typed-product handoff](/pangolin/explanation/typed-product-handoff/).

## Run it yourself

```sh
pnpm install
pnpm --filter data-mapreduce-example start     # exits 0 on success
```

:::caution[What this example proves — and what it deliberately skips]
This demo runs on `InprocWorkerExecutor`, a **test fixture that executes
pipelines in-process** — no container sandbox, no network firewall, no
filesystem isolation. It exists so the demo is instant and dependency-free,
and it must never be used in production. Production dispatches go through
`DispatchExecutor` into isolated compute (local Docker or Fargate). What the
example proves is that the **engine, patterns, and audit chain are
domain-general** — not that data jobs are sandboxed by this demo.
:::

## Next steps

- [How an offload run executes](/pangolin/explanation/how-offload-runs/) — the engine underneath.
- [Typed-product handoff](/pangolin/explanation/typed-product-handoff/) — `needs`, `inputRefs`, provenance closure.
- [Your first offload run](/pangolin/tutorials/first-offload-run/) — the same engine with live workers.
```

- [ ] **Step 2: Vocabulary discipline check**

Run: `grep -niE '\b(compliant|certified|guaranteed|tamper-evident)\b' docs-site/src/content/docs/use-cases/data-pipelines.md`
Expected: no matches.

- [ ] **Step 3: Build the docs site**

Run: `pnpm --filter @pangolin-scale/docs-site build`
Expected: exit 0, no links-validator errors.

- [ ] **Step 4: Commit**

```sh
git add docs-site/src/content/docs/use-cases/data-pipelines.md
git commit -m "docs(use-cases): data pipelines page"
```

---

### Task 5: Site wiring — sidebar section + homepage card row

**Files:**
- Modify: `docs-site/astro.config.mjs` (sidebar array, currently starting at the `Tutorials` entry around line 36)
- Modify: `docs-site/src/content/docs/index.mdx` (insert a CardGrid above the existing "What do you want to do?" section)

- [ ] **Step 1: Add the Use cases sidebar section**

In `docs-site/astro.config.mjs`, insert this entry as the FIRST element of the `sidebar` array (before the existing `{ label: 'Tutorials', ... }` entry):

```js
{
  label: 'Use cases',
  items: [
    { slug: 'use-cases/regulated-document-drafting' },
    { slug: 'use-cases/dev-offload' },
    { slug: 'use-cases/compliance-evidence' },
    { slug: 'use-cases/data-pipelines' },
  ],
},
```

- [ ] **Step 2: Add the homepage "Who is it for?" card row**

In `docs-site/src/content/docs/index.mdx`, insert this block between the `import { Card, CardGrid } ...` line and the existing `## What do you want to do?` heading:

```mdx
## Who is it for?

<CardGrid>
  <Card title="Regulated document drafting" icon="document">
    Batch-draft claims appeals, filings, or reconciliations with parallel
    agents — and hand over a verifiable audit bundle of exactly what ran.
    [Read the use case →](/pangolin/use-cases/regulated-document-drafting/)
  </Card>
  <Card title="Dev offload" icon="laptop">
    Fan codebase maintenance out to sandboxed agents and get back reviewable
    patches — unattended, but never unaccountable.
    [Read the use case →](/pangolin/use-cases/dev-offload/)
  </Card>
  <Card title="Compliance evidence" icon="approve-check">
    Export a sealed evidence bundle per run; an auditor re-verifies it with
    one command — guarantee tiers stated honestly.
    [Read the use case →](/pangolin/use-cases/compliance-evidence/)
  </Card>
  <Card title="Data pipelines" icon="bars">
    The same provable engine for non-LLM batch jobs — typed handoffs, runtime
    fan-out, identical audit chain. Fully offline demo.
    [Read the use case →](/pangolin/use-cases/data-pipelines/)
  </Card>
</CardGrid>
```

Note: `document`, `laptop`, and `bars` are Starlight built-in icon names; `approve-check` is already used on this page. If the build errors on an unknown icon name, substitute a name already used on the page (`rocket`, `puzzle`, `setting`, `approve-check`) rather than hunting the icon list.

- [ ] **Step 3: Build the docs site**

Run: `pnpm --filter @pangolin-scale/docs-site build`
Expected: exit 0; links validator now also checks the four new sidebar slugs and card links.

- [ ] **Step 4: Commit**

```sh
git add docs-site/astro.config.mjs docs-site/src/content/docs/index.mdx
git commit -m "docs(use-cases): sidebar section + homepage card row"
```

---

### Task 6: Audit pass — repo patterns, DRY/SoC, vocabulary, full build

This is the adherence audit the operator requested. Each check is concrete; fix violations inline and re-run.

- [ ] **Step 1: DRY / link-don't-restate check**

Read all four pages in `docs-site/src/content/docs/use-cases/` and verify:
- No page re-explains the hash-chain/Merkle/anchor mechanics beyond ~2 sentences — deep explanation must be a link to `/pangolin/explanation/audit-guarantee-tiers/`.
- No page reproduces the tier table from `audit-guarantee-tiers.md` or the report-field table from `verify-audit-bundle.mdx`.
- No page duplicates another use-case page's terminal excerpt beyond the short 4-line bundle block (which is shared output, not explanation).

- [ ] **Step 2: Single-responsibility / SoC check**

- Each page anchors to exactly ONE example (compliance-evidence anchors to the CLI surface; its only example reference is the offline smoke test) — no page walks through a second example in depth.
- The homepage cards only route (one sentence + link each) — no claims that aren't on the page they link to.
- Sidebar order matches the spec's table order.

- [ ] **Step 3: Repo docs-pattern conformance**

- Frontmatter is `title` + `description` only (matches every existing page).
- All internal links are absolute `/pangolin/...` (the validator enforces this — `errorOnRelativeLinks: true`).
- Asides use `:::note` / `:::caution` directive syntax (valid in `.md` under Starlight).
- File names are kebab-case `.md` under `use-cases/`, matching content-collection conventions.

- [ ] **Step 4: Vocabulary discipline sweep (all four pages at once)**

```sh
grep -rniE '\b(compliant|certified|guaranteed|reproducible)\b' docs-site/src/content/docs/use-cases/
grep -rni 'tamper-evident' docs-site/src/content/docs/use-cases/
```
Expected: first grep matches only inside negated honesty-aside sentences; second grep matches only on `compliance-evidence.md` (tier-qualified) and inside the regulated-drafting honesty aside. Anything else is a violation — fix it.

- [ ] **Step 5: Full build + final verification**

Run: `pnpm --filter @pangolin-scale/docs-site build`
Expected: exit 0, zero links-validator errors.

- [ ] **Step 6: Commit any audit fixes**

```sh
git add docs-site/
git commit -m "docs(use-cases): audit pass — vocabulary, DRY, pattern conformance"
```
(Skip the commit if Steps 1–5 produced no changes.)
