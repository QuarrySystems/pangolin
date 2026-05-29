---
title: Agora Offload — V1 Delivery Spec (Lean Runner)
date: 2026-05-29
status: design (approved direction; implementation plan pending)
branch: docs/agora-offload-v1-spec
authors: [human:Brett, agent:claude-opus-4-8]
builds_on: "[[docs/superpowers/specs/2026-05-28-agora-orchestrator-design.md]]"
---

# Agora Offload — V1 Delivery Spec (Lean Runner)

> **Status:** design note. Approved direction; not yet implemented.
> **This is a delivery cut, not new architecture.** It selects the smallest
> shippable, *productizable* slice of the orchestrator architecture
> ([2026-05-28 orchestrator spec](./2026-05-28-agora-orchestrator-design.md))
> and records the two decisions that scope it: the **lean-runner cut** (defer the
> autonomous-PR layer to V1.1) and the **BSL source-available license**. All
> locked architecture decisions (D1–D11) from the orchestrator spec remain
> binding; this document does not restate them, it *applies* them.

---

## 0. Why this spec exists

The orchestrator engine is built. PRs 1–3 of the orchestrator spec's staging
plan (§13.7) have landed:

- **PR1 (D9):** `AgoraClient.dispatch` split into `fire()` + `reconcile()`.
- **PR2:** `AgoraOrchestrator` operations core — named queues, `depends_on`
  resolution, **resource locks**, per-queue concurrency, the tick-based
  fire-and-reconcile loop, SQLite `RunStateStore`, `ManualTrigger`.
- **PR3:** the `DispatchExecutor` wired end-to-end; `examples/orchestrator-offload`
  drives a one-item run through the full path against a real container.

What is **not** built is everything that turns that engine into a thing a person
other than its author can adopt: a long-running driver, a submission surface that
honors the "orchestrator is the sole DB owner" model (D3), retry, the operator
CLI/MCP surfaces, and — the load-bearing gap — **a way for completed work to
escape the isolated sandbox.** This spec defines that slice.

### 0.1 The product thesis V1 must prove

> **Submit a DAG of agent tasks; they fan out safely across an isolated,
> credential-sealed worker pool with file-level resource locks; each finished
> task drops a reviewable patch artifact you fetch and apply.**

The differentiator is **safe parallelism + isolation**, not autonomy. The
resource-lock primitive — disjoint locks fan out, overlapping locks serialize —
is what lets multiple agents edit one codebase without clobbering each other.
That, sitting on the per-dispatch credential isolation already shipped (secrets
never enter the agent's context; §10.6 privilege split), is the wedge. Autonomy
(agents that open and merge their own PRs) is V1.1 and is *additive*, not a
prerequisite.

### 0.2 The two scoping decisions

| # | Decision | Resolution |
|---|---|---|
| **V1-D1** | Scope depth | **Lean runner + patch escape.** Build the engine surface (serve, submission transport, retry, operator CLI/MCP) plus a *minimal* sandbox-escape (a patch artifact). Defer the typed-output→`Intent`→`IntentInterpreter`→`open-pr`→`approve` pipeline, the `dev` pack, cost budgets, and effect-tier enforcement to **V1.1**. The deferred layer is a strict superset of what V1 ships, so it accretes without refactor. |
| **V1-D2** | License | **Business Source License 1.1 (`BUSL-1.1`).** Whole offload stack is source-available and self-hostable; the Additional Use Grant permits all use **except offering Agora as a hosted/managed orchestration service.** Change Date = **4 years** from first publish; Change License = **Apache-2.0**. No architectural cost — the §10.6 `client`/`service` privilege split already marks the commercial boundary (the future hosted multi-tenant control plane is the `service` side). |

---

## 1. Scope — in, deferred, out

### 1.1 In V1 (build now)

1. **`serve` driver** — the long-running process. Owns the SQLite run-state
   (sole writer, D3), polls the submission inbox, runs the reconcile tick loop on
   a cadence, exits cleanly on signal. Replaces the hand-rolled `while` loop in
   `examples/orchestrator-offload`.
2. **`SubmissionTransport` seam + storage-backed impl** (D5/D10) — clients write
   a Run spec to a `submissions/` prefix; `serve` polls, ingests, and publishes
   status + completion records to an `outbox/` prefix. A thin poll helper over the
   existing `StorageProvider`; works identically on `agora-storage-local`
   (dev) and `agora-storage-s3` (remote). **No inbound networking** to the
   container.
3. **Sandbox escape — minimal `.agora/output.json` + patch artifact** (a reduced
   D7). On finish, the worker captures the workspace diff, uploads it to storage
   as a content-addressed artifact, and writes `.agora/output.json` carrying the
   artifact ref. The executor surfaces that ref as `result_ref` on the run-state
   row. See §3.
4. **Retry/backoff** — per-item attempt counter (the D2 schema already reserves
   retry counters), configurable `maxAttempts` with exponential backoff; an item
   reaches `failed` only after attempts are exhausted; its dependents go
   `skipped`. See §4.
5. **Operator surface** (§10.4–10.6 of the orchestrator spec, V1 subset):
   - CLI: `agora orch serve` (service), `submit`, `status`, `watch` (client),
     `cancel` (client, privileged).
   - MCP: `agora_orchestrator_submit`, `_status`, `_watch` (client only).
   - The privilege tag lives on the operations-API method; the CI allowlist check
     (§10.6) fails if any privileged/service method is reachable over MCP.
6. **Persistent run-state** — SQLite on the service's own volume (D4: named
   Docker volume locally, EBS/EFS remote); not `:memory:`, not `~/.agora`, not S3.
7. **The `default` queue** as the one registered queue, concurrency configured at
   construction. Named queues stay a contract, not a feature (§10.7).
8. **Headline demo** — `examples/offload-fanout`: a single `submit` of a
   multi-item run that proves locks + deps + concurrency + isolation + patch
   escape at once. See §6.
9. **BSL packaging** — root `LICENSE` (BSL 1.1), `license: "BUSL-1.1"` in every
   package.json, a short `LICENSING.md`, and README/marketing reframed to
   "source-available." See §7.

### 1.2 Deferred to V1.1 (additive, no refactor)

- Full typed `output.json` (D7): `outputSchema` validation, `output` data
  products, `intents`, `signals`.
- `Intent` / `IntentInterpreter`, the `dev.open-pr` interpreter, the
  auto-merge-test-only / human-approve policy, and the CLI `approve` verb.
- The `dev` pack and its `code-edit` / `verify` `SubagentShape`s. (V1 names
  plain registered subagents in `WorkItem.inputs`, as PR3 already does.)
- Cost accounting / budget enforcement and the `cron` trigger.
  - **Note on `cron`:** the orchestrator spec floats it in "build now"; this V1
    defers it. `serve` + manual `submit` already delivers *unattended* offload
    (submit once, walk away). *Recurring* scheduling is additive via the existing
    `Trigger` seam and is the **first item to pull into V1.1**. If the
    implementation plan finishes V1 with budget to spare, `cron` is the stretch
    item — but it is not a V1 gate.
- Effect-tier *enforcement* (the vocabulary stays a typed property; nothing
  reads it for policy yet).

### 1.3 Out (branches — let a real task pull them; orchestrator spec §11)

Additional executors (shell, batch-api, dag-plan), additional packs, predicate/
signal/event triggers, named queues beyond `default`, rate-limiting,
`pause`/`resume`, an HTTP submission transport, the `Claim` core type + Mneme
integration. None require a refactor when pulled — that is what the architecture
already bought.

---

## 2. Architecture — what's added, and where it sits

V1 adds no new package boundaries. It fills in `agora-orchestrator` and makes one
small additive change to `agora-worker`.

```
agora-orchestrator (existing pkg)
  src/
    orchestrator.ts          [EXISTING] operations API — extend with retry-aware status
    engine/tick.ts           [EXISTING] reconcile loop — extend: retry on failure, ingest from transport
    runstate/sqlite.ts       [EXISTING] add: attempt counters, result_ref column, persistent-file ctor
    executors/dispatch.ts    [EXISTING] reconcile() now reads patch ref from worker output
    triggers/manual.ts       [EXISTING]
    serve/driver.ts          [NEW] long-running tick + inbox-poll loop; signal handling
    transport/
      submission-transport.ts[NEW] SubmissionTransport seam (contract)
      storage-transport.ts   [NEW] storage-backed inbox/outbox impl (D10)
    operations-api.ts        [NEW] single source of business logic + privilege tags (§10.2/10.6)

agora-cli (existing pkg)
  src/cmd-orch.ts            [NEW] serve|submit|status|watch|cancel — thin translation over operations API

agora-mcp (existing pkg)
  src/tools.ts               [EXTEND] add submit|status|watch tools (client-tagged only); CI allowlist enforced

agora-worker (existing pkg)
  src/entrypoint.ts          [EXTEND] capture workspace diff → upload artifact → write .agora/output.json
```

**Conformance (D8/D11, orchestrator spec §13):** new orchestrator seams live in
`agora-orchestrator/src/contracts/`. CLI/MCP stay pure translators over the
operations API (the §10.2 consolidation principle) — no business logic in the
surfaces. Registries remain construction-time `Record<string, Impl>` maps (D8).

---

## 3. Sandbox escape — the one net-new worker mechanism

This is the load-bearing piece, because the isolation that sells Agora also means
nothing escapes the container by default.

**Contract:** after the `RuntimeAdapter` returns, the worker MUST, on a
successful run:

1. Compute the diff of the dispatch workspace against its initial overlaid state.
2. Upload that patch to storage as a content-addressed artifact via the
   `StorageProvider` already wired into the dispatch.
3. Write `.agora/output.json` — the same sentinel D7 defines, with a **minimal V1
   schema**:

   ```jsonc
   // .agora/output.json — V1 minimal payload
   {
     "schemaVersion": 1,
     "patchRef": "agora://artifacts/sha256:…",  // omitted if the run made no changes
     "summary": "string, optional, one line"
   }
   ```

4. `DispatchExecutor.reconcile()` reads `patchRef` from the sentinel and returns
   it in `ExecutionResult`; the tick loop writes it to the run-state row as
   `result_ref`. `status` renders it; the client fetches the artifact through the
   outbox.

**Additivity (V1 → V1.1):** V1.1's full D7 payload simply adds `output`,
`intents`, and `signals` fields and an `outputSchema` validation step. V1's
`patchRef` is unchanged. No throwaway.

**Open implementation detail (for the plan, not blocking):** diff strategy —
`git diff` against an init commit made at overlay time vs a file-tree snapshot
diff. Recommend the git approach when the workspace is a repo (the common case),
with a file-tree fallback. The runtime adapter likely already has the cleanest
hook point; the plan resolves exactly where the capture call lives.

---

## 4. Retry, failure, and crash-safety

- **Per-item retry.** Each `WorkItem` carries `attempts` (default `maxAttempts`
  configurable per-run, default **2**). On a `failed` reconcile, if attempts
  remain, the item returns to `ready` after an exponential backoff; locks are
  released between attempts. Only after exhaustion does it become terminally
  `failed`.
- **Dependent handling.** A terminally `failed` item marks its transitive
  dependents `skipped` (they can never satisfy `depends_on`). Parallel branches
  with no dependency on the failed item proceed — failure halts only the failed
  lineage, mirroring the DAG-executor discipline.
- **Crash-safety.** Run-state is durable SQLite on the service volume (D3/D4).
  On restart, `serve` reconciles in-flight items from their recorded
  `dispatch_hash` before firing anything new — no double-fire, no lost run. This
  is already the tick loop's shape; V1 makes the store persistent and adds the
  startup reconcile-first pass.

---

## 5. The `serve` driver

A single long-running process (the orchestrator spec's D3 "sole DB owner"):

```
loop:
  1. poll SubmissionTransport inbox → ingest new Run specs (submitRun)
  2. tick(default)            → ready / reconcile / fire within concurrency+locks
  3. publish status + completion records to outbox
  4. sleep(tickInterval)      → until next tick or signal
on SIGTERM/SIGINT: stop firing, finish the in-flight reconcile pass, flush, exit.
```

`tickInterval` is configurable; the loop is the only caller of `tick()` and the
only opener of the DB. CLI/MCP never touch SQLite — they read the outbox and
write the inbox (D3). Deployment reuses `agora deploy` (it is just another
container image; orchestrator spec §10.4).

---

## 6. Acceptance — the headline demo

`examples/offload-fanout/` — one command must demonstrate the whole V1 promise:

- A Run of **N code-edit items + 1 verify item**, where the verify item
  `depends_on` all edits.
- Each edit item declares a **resource lock on the file(s) it touches.** Items
  with disjoint locks fan out to the queue's concurrency; items contending for a
  shared file serialize. (E.g. "rename symbol X across the repo" → one item per
  file, locks per file → maximal safe parallelism; a shared `package.json` edit
  serializes against anything else touching it.)
- `agora orch submit plan.json` returns a run id and **does not block.**
- `agora orch watch <run-id>` shows the tree advancing wave by wave, with
  blocking reasons ("waiting on lock: src/foo.ts", "waiting on dep: verify").
- On completion, **each edit item exposes a `result_ref`**; fetching it yields a
  reviewable patch. The verify item's exit code gates the run.

**V1 is "done" when:** that example runs green against the local Docker stack end
to end; the same `plan.json` + config runs against the Fargate + S3 stack with
only target/storage swapped (local→prod parity); and the MCP `submit`/`status`/
`watch` tools drive the same run from inside a Claude Code session, while the CI
allowlist check proves no privileged method is MCP-reachable.

---

## 7. BSL packaging (V1-D2)

The agora packages are currently `private: true`, `version: 0.0.0` — **nothing
is published yet**, so the license is a clean choice with no relicensing of
shipped artifacts.

- **Root `LICENSE`:** Business Source License 1.1, parameterized:
  - **Licensor:** Quarry Systems.
  - **Licensed Work:** Agora (this repository).
  - **Additional Use Grant:** all use is permitted *except* offering Agora, or a
    derivative, to third parties as a hosted or managed orchestration / agent-
    dispatch service.
  - **Change Date:** 4 years after each version's publish date.
  - **Change License:** Apache-2.0.
- **Per package:** `"license": "BUSL-1.1"` in every `package.json`; a
  `LICENSE` reference at the package root.
- **`LICENSING.md`:** plain-language summary — "source-available; self-host and
  build on it freely; you may not resell it as a service until it converts to
  Apache-2.0 on the Change Date."
- **Messaging:** README and the launch write-up (`docs/sandboxing-ai-agents.md`)
  say **"source-available (BSL)"**, never "open source" (BSL is not OSI-approved).
  This honesty is itself trust-building and matches that draft's existing tone.

---

## 8. Coordination & sequencing notes

- **Depends on the secret-store unification landing.** The patch-escape upload
  and the submission transport both lean on the `StorageProvider` + secret-
  staging paths currently being unified (PR4a, `agora-secret-store`). V1's plan
  should sequence after that merges to avoid churn against a moving seam. Not a
  design dependency — a merge-order one.
- **PR staging (extends orchestrator spec §13.7, which ended at PR3):**
  - **PR4 — `serve` + `SubmissionTransport`.** Driver loop + storage-backed
    inbox/outbox + persistent SQLite + startup reconcile-first. Proves unattended
    submit→run→complete with no patch yet.
  - **PR5 — sandbox escape.** Worker diff-capture + minimal `.agora/output.json`
    + `result_ref` plumbing through executor/run-state/outbox.
  - **PR6 — operator surface.** Operations API consolidation + CLI `cmd-orch`
    + MCP tools + the §10.6 CI allowlist check. Retry/backoff lands here or
    folds into PR4.
  - **PR7 — `offload-fanout` example + BSL packaging + docs.** The acceptance
    demo, license files, README/landing reframe.

---

## 9. Self-review checklist (for the implementation plan)

- Every CLI/MCP command is a pure translator over the operations API — grep for
  business logic in `cmd-orch.ts` / `tools.ts` and move it down (D8/§10.2).
- The MCP server refuses to register any non-`client` method; CI proves it.
- `serve` is the only DB opener and the only `tick()` caller.
- `.agora/output.json` V1 payload is a strict subset of the D7 schema (forward-
  compatible field names).
- `SubmissionTransport` and `RunStateStore` stay behind their seams so S3→HTTP
  and SQLite→networked-DB remain additive swaps.
- No deferred-layer (Intent/interpreter/pack/budget/cron) code leaks into V1 —
  contracts may exist; implementations do not.

---

End of spec. The engine exists; V1 is the steering wheel, the way work gets out,
and the license that lets you ship it without handing a competitor the product.
