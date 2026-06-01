---
title: Agora Offload — V1 Delivery Spec (Lean Runner)
date: 2026-05-29
status: implemented (V1 shipped — all five waves merged to main, 2026-06-01; PRs #18/#19/#21/#22/#23)
branch: docs/agora-offload-v1-spec
authors: [human:Brett, agent:claude-opus-4-8]
builds_on: "[[docs/superpowers/specs/2026-05-28-agora-orchestrator-design.md]]"
---

# Agora Offload — V1 Delivery Spec (Lean Runner)

> **Status:** SHIPPED. V1 is implemented and merged to `main` (2026-06-01) across
> five waves — `offload-runner` (#18), `offload-escape` (#19), `offload-audit`
> (#21), `offload-surface` (#22), `offload-launch` (#23). The local Docker §7
> acceptance is proven live (safe fan-out + per-edit patch `result_ref`s + a
> verifiable tamper-detecting audit bundle); the Fargate+S3 parity run is the one
> operator-deferred item. Operator how-to: [`docs/offload-orchestration.md`](../../offload-orchestration.md).
> This document is retained as the design record.
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
> task drops a reviewable patch artifact — and the whole run produces a
> tamper-evident audit trail of exactly what ran, with what inputs, under whose
> authority.**

The edge is **security + deterministic, auditable execution** — Agora is the
*compliance-ready* way to run coding agents against real repos, real credentials,
and (self-hosted) real regulated data. Three legs:

1. **Security / isolation.** Per-dispatch credential sealing (secrets never enter
   the agent's context or logs; env firewall; auto-TTL, ADR 0007) plus the §10.6
   privilege split — privileged ops are *unreachable* from the AI loop, enforced
   at the boundary and CI-checked. Access control that lives where the agent
   can't route around it.
2. **Determinism.** Every dispatch is content-addressed and described by a signed
   manifest (what subagent, what capabilities, what env, what worker image
   digest, what model + params — all by hash). Reproducible *environment and
   inputs*. (Honest bound: §6.1 — agent *output* is recorded, not reproducible.)
3. **Auditability.** A durable, **Merkle-rooted** record of every run, anchored
   for **tamper-evidence** through a pluggable seam (detection-only without an
   external anchor; genuinely tamper-evident with one — §6.3), exportable as a
   verifiable evidence bundle (`agora orch audit`).

Resting underneath: **safe parallelism** — the resource-lock primitive (disjoint
locks fan out, overlapping locks serialize) lets multiple agents edit one
codebase without clobbering each other. Autonomy (agents that open and merge
their own PRs) is V1.1 and is *additive*, not a prerequisite.

**The engine is executor-agnostic; AI is the flagship executor, not the engine
(V1-D4).** The `Executor` contract (`fire`/`reconcile`) and everything above it —
queues, deps, locks, run-state, retry, and the entire §6 audit/manifest layer —
have nothing AI-specific in them. The edge (isolation + determinism + tamper-
evident audit) applies to *any* unit of work: a shell job, a batch call, a human
approval. That is a strength — it widens the market the *same pitch* serves
("secure, auditable execution for every unit of work — AI-native, not AI-only")
and lets the determinism claim sharpen per executor (§6.1). **V1 ships exactly one
executor (AI dispatch)**; the value V1 captures from this is *architectural*:
keep the engine, audit format, and operations API executor-agnostic so the second
executor (likely a sandboxed `command`/shell job) is purely additive. Building it
waits for a real task (orchestrator spec §11 discipline; §1.3 here).

**Honesty constraint (brand-protecting).** SOC2 is an org attestation; HIPAA is a
regime for covered entities. Software is never itself "certified." Agora ships the
**technical controls and audit evidence** that make a customer's program
achievable. This spec, the README, and all copy say **"compliance-ready"** —
never "compliant," "certified," or "reproducible AI output." See §6.

### 0.2 The scoping decisions

| # | Decision | Resolution |
|---|---|---|
| **V1-D1** | Scope depth | **Lean runner + patch escape.** Build the engine surface (serve, submission transport, retry, operator CLI/MCP) plus a *minimal* sandbox-escape (a patch artifact). Defer the typed-output→`Intent`→`IntentInterpreter`→`open-pr`→`approve` pipeline, the `dev` pack, cost budgets, and effect-tier enforcement to **V1.1**. The deferred layer is a strict superset of what V1 ships, so it accretes without refactor. |
| **V1-D2** | License | **Business Source License 1.1 (`BUSL-1.1`).** Whole offload stack is source-available and self-hostable; the Additional Use Grant permits all use **except offering Agora as a hosted/managed orchestration service.** Change Date = **4 years** from first publish; Change License = **Apache-2.0**. No architectural cost — the §10.6 `client`/`service` privilege split already marks the commercial boundary (the future hosted multi-tenant control plane is the `service` side). Self-host is also the **compliance model** (§6.7): regulated data never leaves the customer's account. |
| **V1-D3** | Compliance edge | **Folded into V1, not fast-followed.** The technical controls that constitute the edge — signed dispatch manifest, Merkle-rooted audit log with a **pluggable tamper-evidence anchor** (`AuditAnchor` seam), actor identity on every operation, `agora orch audit` evidence export, and encryption-at-rest by default — are **V1 acceptance gates** (§6). Deferred: certification/process, BYOK-KMS, full role-based RBAC, hosted-V2 BAAs, the Bedrock runtime adapter. The claim is **"compliance-ready,"** never "compliant/certified" (§6.1). |
| **V1-D4** | Executor scope | **Executor-agnostic engine, AI flagship, one executor in V1.** The engine, audit format, and operations API carry nothing AI-specific. V1 builds *only* the AI `DispatchExecutor`, but the **dispatch manifest is executor-polymorphic** (§6.2) and copy positions Agora as an execution engine, not an AI tool. Additional executors (`command`/shell, batch, http, human-approval) are additive branches pulled by real tasks (§1.3). Rationale: positioning is free and the manifest schema is expensive to migrate once signed history exists — so lock the shape now, build the breadth later. |

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
     `cancel` (client, privileged), `audit <run-id>` (client, read-only — §6.5).
   - MCP: `agora_orchestrator_submit`, `_status`, `_watch` (client only). `audit`
     is **not** on MCP (auditing is an operator action, not an AI-loop action).
   - The privilege tag lives on the operations-API method; the CI allowlist check
     (§10.6) fails if any privileged/service method is reachable over MCP.
6. **Persistent run-state** — SQLite on the service's own volume (D4: named
   Docker volume locally, EBS/EFS remote); not `:memory:`, not `~/.agora`, not S3.
7. **The `default` queue** as the one registered queue, concurrency configured at
   construction. Named queues stay a contract, not a feature (§10.7).
8. **Compliance & audit controls (the edge, V1-D3)** — signed dispatch
   **manifest** (§6.2), durable **Merkle-rooted audit log + pluggable `AuditAnchor`
   tamper-evidence seam** (§6.3),
   **actor identity** on every operation (§6.4), the `agora orch audit` evidence
   **export** (§6.5), and **encryption-at-rest by default** with patch artifacts
   treated as sensitive data (§6.6). These are acceptance gates, not polish. See §6.
9. **Headline demo** — `examples/offload-fanout`: a single `submit` of a
   multi-item run that proves locks + deps + concurrency + isolation + patch
   escape **and produces a verifiable audit bundle** at once. See §7.
10. **BSL packaging** — root `LICENSE` (BSL 1.1), `license: "BUSL-1.1"` in every
    package.json, a short `LICENSING.md`, and README/marketing reframed to
    "source-available." See §8.

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
- **Authorization policy — implementor-owned, deferred.** agora is mechanism, not
  policy: it ships the enforcement points and identity *primitives* (§6.4 `actor`,
  the §10.6 capability split — both *mechanism*, not authz), and will later expose
  an `Authorizer` seam the *implementor* fills with their own policy. V1 ships
  **none** (single operator, D6 "whoever launched"). agora never owns roles,
  sharing, or who-can-do-what — that's the implementor's. Cheap to add later: the
  operations API (§10.2) is already the single chokepoint where an `Authorizer`
  would be called.
- **Compliance deepening (V1 ships the controls; these extend them):** customer-
  managed keys (BYOK/KMS), full role-based RBAC (V1 has the privilege split +
  actor identity, not roles), automated retention/purge policy, SIEM/log-export
  integrations, and a **Bedrock-backed `RuntimeAdapter`** for keeping the model
  call inside a customer's AWS BAA boundary (§6.7) — additive via the existing
  adapter seam. The SOC2 audit / HIPAA risk assessment themselves are
  organizational process, not software, and out of scope by nature.

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
    runstate/sqlite.ts       [EXISTING] add: attempt counters, result_ref, manifest_ref, audit_chain_head cols
    executors/dispatch.ts    [EXISTING] reconcile() reads patch ref + writes the dispatch manifest (§6.2)
    triggers/manual.ts       [EXISTING]
    serve/driver.ts          [NEW] long-running tick + inbox-poll loop; signal handling
    transport/
      submission-transport.ts[NEW] SubmissionTransport seam (contract)
      storage-transport.ts   [NEW] storage-backed inbox/outbox impl (D10)
    audit/
      manifest.ts            [NEW] build/hash the dispatch manifest (§6.2)
      audit-log.ts           [NEW] Merkle-per-epoch append + verify (§6.3)
      signer.ts              [NEW] Signer seam + KmsSigner/LocalSigner (§6.3)
      anchor.ts              [NEW] AuditAnchor seam + LocalAnchor/S3ObjectLockAnchor (§6.3)
    operations-api.ts        [NEW] single source of business logic + privilege tags + actor capture (§6.4)

agora-cli (existing pkg)
  src/cmd-orch.ts            [NEW] serve|submit|status|watch|cancel|audit — thin translation over operations API

agora-mcp (existing pkg)
  src/tools.ts               [EXTEND] add submit|status|watch tools (client-tagged only); CI allowlist enforced

agora-worker (existing pkg)
  src/entrypoint.ts          [EXTEND] capture workspace diff → upload artifact → write .agora/output.json;
                             emit the lifecycle stream as durable, chainable audit entries (§6.3)
```

**Conformance (D8/D11, orchestrator spec §13):** new orchestrator seams live in
`agora-orchestrator/src/contracts/`. CLI/MCP stay pure translators over the
operations API (the §10.2 consolidation principle) — no business logic in the
surfaces. Registries remain construction-time `Record<string, Impl>` maps (D8).

**Executor-agnostic guardrail (V1-D4):** nothing in `engine/`, `audit/`,
`runstate/`, or `operations-api.ts` may reference AI/dispatch concepts — those
live only in `executors/dispatch.ts` and the manifest's `executorManifest` block.
The engine sees `WorkItem.executor` (a string) and `inputs` (opaque); the audit
layer sees an opaque `executorManifest`. This is what makes executor #2 additive.

### 2.1 End-to-end flow (V1 end-state)

The full request path. **All five waves are now shipped (merged to `main`,
2026-06-01):** `offload-runner` #18, `offload-escape` #19, `offload-audit` #21,
`offload-surface` #22, `offload-launch` #23. The `✅`/`◷` markers in the diagram
below were the in-flight tracker; every leg is now `✅`.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ CLIENT  (operator / Claude Code session)                                  │
│   CLI:  orch submit · status · watch · cancel · audit   ✅ surface        │
│   MCP:  submit · status · watch  (client-only; audit is CLI-only) ✅      │
└───────┬──────────────────────────────────────────────▲────────────────────┘
        │ write Run spec                                 │ poll status/result/
        │ (NO inbound networking)                        │ patchRef + audit bundle
        ▼                                                │
┌──────────────────────┐                      ┌──────────────────────────────┐
│ MailboxStore (mutable)│                      │  StorageProvider (content-    │
│   inbox/  ── poll ──┐ │                      │  addressed, hash-verified)    │
│   outbox/ ◄── publish│ │                      │   • capability/env/subagent   │
│   dead/             │ │                      │     bundles    (in)           │
└─────────────────────┼─┘                      │   • patch artifacts  ✅escape │
        ▲             │                         │   • dispatch manifests ✅     │
        │             ▼                         │   • audit roots/proofs ✅audit │
        │   ┌───────────────────────────────────────────────┐                 │
        │   │ serve daemon  ✅runner   (sole DB writer · only │                 │
        │   │ tick() caller · clean SIGTERM · reconcile-first)│                 │
        │   │   loop: pollInbox→submitRun→tick→publish status │                 │
        │   └───────────────┬─────────────────────────────────┘                │
        │                   │ tick()                                            │
        │   ┌───────────────▼─────────────────────────────────┐                │
        └───┤ Orchestrator engine ✅runner                     │                │
            │   queue · deps (DAG) · resource locks · retry/   │                │
            │   backoff · skip-cascade · recoverStranded       │                │
            │   run-state ► SQLite (durable volume)            │                │
            │     cols: status,dispatch_hash,attempts,         │                │
            │           result_ref ✅, manifest_ref ✅          │                │
            └───────────────┬──────────────────────────────────┘               │
              fire(item,ctx) │   ▲ reconcile → {status, resultRef ✅}            │
                             ▼   │                                              │
            ┌────────────────────────────────────────────────┐                 │
            │ DispatchExecutor  (executor-specific; engine     │                │
            │ stays agnostic, V1-D4)                           │                │
            │  • fire:  build+put §6.2 manifest (refs only) ✅ │──put manifest──►│
            │           → client.dispatch.fire                 │                │
            │  • reconcile: read .agora/output.json sentinel   │◄─get sentinel──┤
            │               → resultRef ✅                      │                │
            └───────────────┬──────────────────────────────────┘                │
                            │ run container (compute provider)                  │
   ╔════════════════════════▼═══════════════════════════════════╗              │
   ║ WORKER CONTAINER  (the sandbox — nothing escapes by default) ║              │
   ║   1 overlay capability bundles ───────────────◄── fetch ─────╫──────────────┤
   ║   2 resolve secrets via SecretStore (values, log-redacted)   ║              │
   ║   3 run agora-setup.sh                                       ║              │
   ║   4 captureBaseline (git write-tree) ✅escape                ║              │
   ║   5 RuntimeAdapter → AI agent edits the workspace            ║              │
   ║   6 computeWorkspacePatch (git diff, excl .agora/) ✅        ║              │
   ║   7 put patch artifact (content-addressed) ────── upload ────╫─────────────►│
   ║   8 write .agora/output.json {schemaVersion,patchRef} ───────╫─────────────►│
   ║   9 emit lifecycle events ──────────────────────────────────╫──┐           │
   ╚══════════════════════════════════════════════════════════════╝  │          │
                                                                       │          │
            ┌──────────────────────────────────────────────┐  events  │          │
            │ Audit  ✅audit  (engine-side, executor-agnostic)│◄────────┘          │
            │  hash-chain → Merkle-per-epoch → Signer(root)  │── anchor root ────►│
            │  → AuditAnchor (LocalAnchor=detect /           │                    │
            │    S3ObjectLockAnchor=external-immutable)      │                    │
            │  verify = recompute → fetch anchored → compare │                    │
            └────────────────────────────────────────────────┘                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Secret discipline:** values flow ONLY into the worker (log-redacted);
  manifests & audit entries record **references only** — safe to hand an auditor.
- **Two seams:** content-addressed artifacts → `StorageProvider`; mutable queue
  (inbox/outbox) → `MailboxStore`. Local→Fargate+S3 parity is a target swap.

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

## 6. Compliance & audit controls (the edge)

V1-D3 makes these **acceptance gates**, not fast-follows — they are what the
product is *for*. Scope honestly: Agora ships the **technical controls and audit
evidence** that make a customer's SOC2 / HIPAA program achievable. Agora is never
itself "certified/compliant"; copy says **"compliance-ready."**

### 6.1 The determinism claim (exactly what we stand behind)

> **Deterministic, content-addressed execution *environment and inputs*; a
> complete, tamper-evident *record* of what ran and what it produced.**

The guarantee is **per-executor**, and saying so precisely is the credible
version of the claim:

- **Deterministic executors** (a pinned container running a pinned command over
  content-addressed inputs — the future `command` executor): output *is*
  reproducible. Same manifest → same result, bit for bit.
- **AI executor (V1):** LLM output is non-deterministic. V1 makes **no** claim
  that agent results are reproducible — it guarantees the *environment and inputs*
  are reproducible (by hash) and the *result* is completely recorded.

Marketing copy MUST NOT imply reproducible AI output. Stating the bound — strong
where earned, honest where not — is a brand asset, not a weakness; a security
buyer trusts the vendor who draws the line. The audit framework (§6.2–6.3) spans
both cases unchanged.

### 6.2 Dispatch manifest — "exactly what ran"

Every fired WorkItem produces a content-addressed, signed **manifest**. The
envelope is executor-agnostic; the executor-specific detail nests in one
content-hashed `executorManifest` block (V1-D4) so a second executor never forces
an audit-format migration:

```jsonc
{
  "schemaVersion": 1,
  "runId": "...", "itemId": "...", "parent": "run:...",
  "executor":   "dispatch",                  // which executor kind ran this
  "executorManifest": {                      // executor-defined, content-hashed
    // dispatch (AI) fills:
    "subagent":     { "name": "...", "contentHash": "sha256:..." },
    "capabilities": [{ "name": "...", "contentHash": "sha256:..." }],
    "env":          { "name": "...", "contentHash": "sha256:..." },
    "workerImage":  "ghcr.io/quarrysystems/agora-worker@sha256:...",  // digest, not tag
    "model":        { "id": "claude-...", "temperature": 0, "maxTokens": 0 }
    // a future `command` executor would instead fill { image, argvHash, commandRef }
  },
  "secretRefs": ["agora://secrets/..."],     // REFERENCES ONLY — never values (all executors)
  "actor":      "human:brett | agent:<id>",
  "submittedAt":"ISO-8601", "firedAt": "ISO-8601",
  "manifestHash":"sha256:...",               // self-hash over the above
  "signature":  "..."                        // present when a signing key is configured
}
```

The dispatch `executorManifest` fields already exist in the "resolved" block
emitted today (content-addressed `subagent`/`capabilities`/`env` hashes, the
digest-pinned worker image). V1 formalizes them into one persisted, hashed record
and adds model params + actor + timestamps. Two runs of the same manifest had
identical inputs and environment, *by hash* — that is the determinism artifact.
The envelope (`secretRefs`, `actor`, hashing, signing, chain linkage) is shared
across all executor kinds.

**Secret discipline (load-bearing):** the manifest records secret *refs*, never
values — the firewall that keeps secrets out of the agent's context also keeps
them out of the audit trail, so a manifest is safe to hand an auditor.

### 6.3 Tamper-evident audit log

The worker already emits a lifecycle event stream (`worker.boot`,
`dispatch.started`, `needs_input`, `dispatch.finished`, `dispatch.failed`). V1
turns that stream into a verifiable record in three layers — and crucially,
**the trust anchor is a pluggable seam (`AuditAnchor`), not a hard dependency**,
so an operator who doesn't need external immutability isn't forced to run it.

**The distinction that drives the design: detection ≠ evidence.** A hash chain
(or Merkle tree) alone only *detects* tampering — an attacker who controls the
store can mutate entries and recompute the whole structure *and* its head. Real
tamper-*evidence* requires anchoring the head where the writer cannot silently
rewrite it. So:

1. **Structure (always on, in-engine).** Entries are persisted durably,
   content-addressed, joined to the run-state row, hash-chained
   (`entryHash = sha256(canon(entry) ‖ prevHash)`, genesis `prevHash = ""`), and
   the epoch's `entryHash` leaves are accumulated into a **Merkle tree per
   anchoring epoch** (epoch = run-completion for agora). The epoch root summarizes
   every entry; inclusion proofs are cheap. This layer gives *detection*,
   provider-agnostic, with no external dependency.
   **Pinned hash algorithm (shared with Mneme):** SHA-256; Merkle leaves
   domain-separated with a `0x00` prefix, internal pairs with `0x01` (second-
   preimage resistance); empty set → 32 zero bytes; an odd level carries up its
   last node unhashed. agora's lifecycle-entry canonical form is an ordered, JSON-stringified
   field array (agora pins its own fields — they differ from Mneme's claim events —
   but the chaining + Merkle + domain-separation rules are identical, so the
   *protocol* is bit-compatible).
2. **Signature (composable `Signer` seam).** The epoch root is signed before
   anchoring — `KmsSigner` (asymmetric key in KMS; private half never leaves it;
   every sign call is CloudTrail-logged) for production, `LocalSigner` (**ed25519**
   via `node:crypto`; public key exported **SPKI DER**) or `NoneSigner` for dev.
   ed25519/SPKI is the shared baseline with Mneme so signatures verify across both.
   A DB-only attacker without the key can't forge a valid root; non-repudiation,
   and key *use* is itself audited.
3. **Anchor (pluggable `AuditAnchor` seam).** The signed root goes to an external
   sink the app *cannot silently rewrite*. This is the load-bearing tamper-
   *evidence* layer, and it is an adapter precisely so deployments pick their
   assurance tier:

   | `AuditAnchor` adapter | `guarantee` | What it buys |
   |---|---|---|
   | `LocalAnchor` (default) | `detect` | Root + head in the same store. Catches accidental/clumsy mutation; **not** evidence against an attacker who controls the DB. Dev / low-assurance. |
   | `S3ObjectLockAnchor` | `external-immutable` | Signed root → S3 Object Lock **compliance mode** (versioned; *not even account-root* can delete before retention) in the customer's own account — a different trust domain from the app DB. The real tamper-evidence tier. |
   | `WitnessAnchor` (deferred) | `witnessed` | Also pushes the root to a cross-org witness (RFC 3161 TSA / transparency log) for customers who won't trust even their own WORM admin. Additive. |

**Why a seam, not a requirement (matches D8).** The engine *always* builds the
Merkle structure; *where the root anchors* — and therefore the strength of the
guarantee — is injected at construction, exactly like compute/storage/
credentials. No deployment is forced onto S3 Object Lock; the strong path is a
one-line swap and is first-class. **The `AuditAnchor` + `Signer` contracts are
shared with Mneme verbatim** (same methods, same `guarantee` levels) — the
platform's two halves anchor identically, and an implementer learns one model.
(Not shared *code* yet — agora takes no Quarry-lib deps, D11 — but identical
*shape*, a candidate for the eventual extracted substrate.)

**Pinned contract (normative — transcribed from Mneme verbatim, `src/audit/types.ts`):**

```typescript
export type Guarantee = 'detect' | 'external-immutable' | 'witnessed';
/** Licenses the "tamper-evident" claim only at rank >= external-immutable. */
export const GUARANTEE_RANK: Record<Guarantee, number> = { detect: 0, 'external-immutable': 1, witnessed: 2 };

export interface Signature { alg: string; bytes: Uint8Array; keyRef?: string; }
export interface AnchorReceipt { anchorId: string; epochId: string; guarantee: Guarantee; at: number; locator?: string; }
export interface AnchoredRoot { epochId: string; root: Uint8Array; signature?: Signature; receipt: AnchorReceipt; }

export interface Signer { sign(rootHash: Uint8Array): Promise<Signature>; readonly keyRef?: string; }

export interface AuditAnchor {
  readonly id: string;
  readonly guarantee: Guarantee;
  anchor(epoch: { epochId: string; root: Uint8Array; signature?: Signature }): Promise<AnchorReceipt>;
  fetch(range: { epochId?: string; since?: string }): Promise<AnchoredRoot[]>;
}
```

These shapes are the platform protocol; agora and Mneme each define them
independently but **identically** (conformance vectors keep them from drifting).

**Honesty is enforced by the seam, not by discipline alone.** Every `AuditAnchor`
declares its `guarantee`, and `agora orch audit` (§6.5) **prints the anchor in
force and its guarantee on the verification report.** The product's *claim* is
scoped to the configured anchor: **"tamper-evident"** is licensed only at
`external-immutable` (or `witnessed`); at `detect` the honest word is
**"tamper-detecting."** Copy MUST NOT call a `detect`-tier deployment tamper-
evident (ties to §6.1 / V1-D3). An auditor reads the guarantee off the bundle,
not off the marketing.

**Verification** = recompute each epoch's Merkle root from its entries →
**`AuditAnchor.fetch()` the anchored root** (verification MUST consult the external
anchor, not a locally-stored copy — that is the whole point) → the recomputed root
MUST equal the fetched anchored root → the signature MUST verify. **A mismatch, or
a missing/unreachable anchored root, means the run is NOT tamper-evident** and the
report drops to the honest tier (`tamper-detecting`) regardless of which anchor was
*configured* — the claim follows what verification can *prove*, never what was
merely declared. Tamper anywhere before the last anchored epoch yields a mismatch;
a *missing* expected
anchor is itself detectable; anchoring cadence bounds the rewritable window.

### 6.4 Actor identity on every operation

Every operations-API method records the **actor** that invoked it (`submit`,
`cancel`; `approve` in V1.1). Strengthens D6 ("whoever launched") into recorded
attribution on each privileged action — who offloaded what, who cancelled what,
when. Required for SOC2 access-review evidence.

### 6.5 `agora orch audit <run-id>` — the exportable evidence bundle

One command produces a verifiable bundle for an auditor or incident review:
per-item manifests (§6.2) + the Merkle-rooted event log and its anchor
receipt(s) (§6.3) + `result_ref`s +
outcomes + retry history + actors + a **verification report** (Merkle roots match
their entries, roots match the anchored/signed roots, signatures verify, manifest
hashes match) that **names the `AuditAnchor` in force and its `guarantee` tier**
(§6.3) — so the report itself states whether this run is *tamper-evident* or only
*tamper-detecting*. This is the demoable compliance artifact and the single most
persuasive asset for a security buyer. Client-side, read-only; CLI-only (not MCP —
auditing is an operator action, not an AI-loop action).

### 6.6 Encryption & data sensitivity

- **At rest:** run-state DB, manifests, audit logs, and **patch artifacts**
  encrypted at rest by default where the seam allows — S3 SSE (KMS-capable)
  remote; encrypted volume locally. On by default, documented.
- **In transit:** TLS on all storage/transport hops (S3 default; documented for
  self-host).
- **Patches are sensitive.** A patch from a HIPAA workload can contain PHI. Treat
  `result_ref` artifacts as confidential: encrypted, access-controlled,
  retention-configurable. (Automated retention policy is V1.1; V1 ships the manual
  purge path and documents the data flow.)

### 6.7 The self-host / HIPAA architecture advantage

The BSL self-host model (V1-D2) is also the compliance model: **regulated data
never leaves the customer's own AWS account.** The covered entity runs `serve` in
its VPC; Quarry Systems is not a business associate, so **no BAA with us is
required.** The one external dependency is the model call — routing Claude through
**Amazon Bedrock** keeps it inside the customer's existing AWS BAA boundary. The
`RuntimeAdapter` seam makes a Bedrock-backed adapter additive (deferred, §1.2);
V1 documents the requirement and the recommended deployment shape.
**Due-diligence item (not a code task):** confirm model-endpoint BAA terms for
each supported runtime before publishing HIPAA guidance.

---

## 7. Acceptance — the headline demo

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
- `agora orch audit <run-id>` emits an evidence bundle whose **verification report
  passes** — every manifest hash matches, each epoch's Merkle root recomputes and
  matches its signed/anchored root, signatures verify — the report **names the
  anchor and its guarantee tier**, and the bundle contains **no secret values**
  (refs only). Mutating any persisted entry makes verification fail. On the local
  stack the demo runs `LocalAnchor` and the report honestly reads
  **tamper-detecting**; the Fargate+S3 parity run uses `S3ObjectLockAnchor` and
  reads **tamper-evident**, *and a DB-side tamper is caught by mismatch against the
  Object-Lock-anchored root the attacker cannot rewrite.* (The edge, demonstrated —
  and honestly labeled per tier.)

**V1 is "done" when:** that example runs green against the local Docker stack end
to end; the same `plan.json` + config runs against the Fargate + S3 stack with
only target/storage/anchor swapped (local→prod parity); the MCP `submit`/`status`/
`watch` tools drive the same run from inside a Claude Code session, while the CI
allowlist check proves no privileged method is MCP-reachable; **and the audit
bundle verifies, names its guarantee tier, and the `external-immutable` run
survives a DB-side tamper attempt.**

---

## 8. BSL packaging (V1-D2)

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

## 9. Coordination & sequencing notes

- **Dependency satisfied — secret-store unification merged** (PR4a #13 + PR4b #14,
  2026-05-30). The patch-escape upload and the submission transport lean on the
  now-unified `StorageProvider` + `SecretStore` paths; that seam is stable, so the
  offload waves below build on current `main` without churn.
- **Wave staging (content-named to avoid colliding with the repo's merge-order PR
  numbers; extends the orchestrator spec §13.7, which ended at PR3).** The repo's
  "PR4" is the secret-store unification above — these offload waves are the *next*
  PRs after #14:
  - **`offload-runner`** — `serve` + `SubmissionTransport` driver loop + storage-
    backed inbox/outbox + persistent SQLite + startup reconcile-first + retry +
    actor identity (§6.4). Proves unattended submit→run→complete, no patch yet.
    *(DAG plan authored + audited: `plans/2026-05-30-agora-offload-runner-dag.md`.)*
  - **`offload-escape`** — worker diff-capture + minimal `.agora/output.json` +
    `result_ref` plumbing, **and** the signed dispatch manifest (§6.2) on fire.
    (Manifest + escape share the executor/run-state plumbing, so they land together.)
  - **`offload-audit`** — tamper-evident audit log (§6.3): Merkle-per-epoch +
    `Signer` seam (`KmsSigner`/`LocalSigner`) + `AuditAnchor` seam (`LocalAnchor`
    default, `S3ObjectLockAnchor`) + a `verify` routine (fetch-and-compare, §6.3)
    that prints the guarantee tier. Seam shapes match Mneme verbatim. Encryption-
    at-rest defaults (§6.6) land here. (`WitnessAnchor`/TSA tier deferred.)
  - **`offload-surface`** — operations-API consolidation + CLI `cmd-orch` (incl.
    `audit`, §6.5) + MCP tools + the §10.6 CI allowlist check.
  - **`offload-launch`** — `offload-fanout` example + BSL packaging + docs: the
    acceptance demo (incl. audit-bundle verify + tamper check), license files,
    README/landing reframe to the security/determinism/auditability edge.

---

## 10. Self-review checklist (for the implementation plan)

- Every CLI/MCP command is a pure translator over the operations API — grep for
  business logic in `cmd-orch.ts` / `tools.ts` and move it down (D8/§10.2).
- The MCP server refuses to register any non-`client` method; CI proves it.
  `audit` is CLI-only and never reaches MCP.
- `serve` is the only DB opener and the only `tick()` caller.
- `.agora/output.json` V1 payload is a strict subset of the D7 schema (forward-
  compatible field names).
- **No secret values in any manifest, audit entry, or exported bundle** — refs
  only; add a test that greps an export for known secret material and fails on a
  hit.
- **Audit verifies end-to-end, and a deliberately mutated entry fails** — prove it
  with a test: recompute Merkle root → match anchored/signed root → verify
  signature. Include a test where the DB is mutated but the `external-immutable`
  anchor's root is not, and verification correctly fails.
- **The `guarantee` claim is never overstated** — assert in a test that a bundle
  produced under `LocalAnchor` reports `tamper-detecting`, and copy/UX never label
  a `detect`-tier run "tamper-evident" (§6.3).
- **`AuditAnchor` + `Signer` seam shapes match Mneme's** — same method names and
  `guarantee` levels, so the platform halves stay consistent.
- `SubmissionTransport` and `RunStateStore` stay behind their seams so S3→HTTP
  and SQLite→networked-DB remain additive swaps.
- No deferred-layer (Intent/interpreter/pack/budget/cron/RBAC/BYOK) code leaks
  into V1 — contracts may exist; implementations do not.
- **Executor-agnostic (V1-D4):** grep `engine/`, `audit/`, `runstate/`,
  `operations-api.ts` for `subagent`/`model`/`dispatch`/`claude` — any hit is a
  leak. The manifest envelope and audit chain must not know which executor ran.
- All public copy says **"compliance-ready"** and **never** "compliant,"
  "certified," or "reproducible AI output" (§6.1).

---

End of spec. The edge is security + deterministic, tamper-evident auditability;
the engine already exists; V1 is the steering wheel, the way work gets out, the
proof of what ran, and the license that lets you ship it without handing a
competitor the product.
