---
title: Agora Offload — offload-launch wave design (acceptance demo + BSL + docs)
date: 2026-06-01
status: design (approved direction; DAG plan pending)
branch: offload-launch (stacked on offload-surface / PR #22)
authors: [human:Brett, agent:claude-opus-4-8]
builds_on:
  - "[[docs/superpowers/specs/2026-05-29-agora-offload-v1-design.md]]"
  - "[[docs/superpowers/specs/2026-05-31-agora-offload-surface-design.md]]"
---

# offload-launch — the acceptance demo, the license, and the launch framing

> **Status:** wave design note. The fifth and final offload wave. Implements V1
> spec §1.1 items 9–10, §7 (headline demo), §8 (BSL packaging). Does NOT restate
> the V1 canon — it *delivers* it. Stacked on `offload-surface` (PR #22): the demo
> uses the `agora orch` CLI + `OperationsApi` that wave shipped, so this branch is
> based on `offload-surface` and merges after it.

After this wave, V1 is shippable: the engine (offload-runner), the sandbox escape +
signed manifest (offload-escape), the tamper-evident audit log (offload-audit), the
operator surface (offload-surface), and now the **proof it all works together**, the
**license** that lets it ship, and the **framing** that sells the edge.

## Locked decisions (brainstormed 2026-06-01)

| # | Decision | Resolution |
|---|---|---|
| **L1** | License | **BSL-1.1**, overriding the FSL-1.1-MIT currently in the repo (which was committed per the older MVP spec). Matches offload v1 spec V1-D2. Rationale: the narrow, explicit "no hosted/managed service" Additional Use Grant is the lowest-friction restriction for the self-host/compliance users V1 targets, maps onto the §10.6 client/service split, and BSL is the recognized incumbent. The offload v1 spec already specifies it; nothing is published yet (clean swap). |
| **L2** | Demo form | **Both.** A real-Docker runnable `examples/offload-fanout` (the §7 demoable artifact) **and** a deterministic, no-LLM, no-Docker CI integration test that proves the fan-out + audit acceptance mechanics in CI. |
| **L3** | Branch base | **Stacked on `offload-surface`** (new worktree off that branch). Merges after PR #22. |
| **L4** | Verification boundary | I build + typecheck + lint the real-Docker example and run the **deterministic CI test green** (the automated proof). The **live container run** (real `ANTHROPIC_API_KEY` + Docker; and the Fargate+S3 parity run) is **operator-verified** — attempted at the end of the wave if Docker + a key are available, but not a CI gate. Copy never claims a green e2e that wasn't run. |
| **L5** | README scope | Focused top-section reframe: lead with the security/determinism/tamper-evident-audit edge + "source-available (BSL)" + the offload demo; keep the accurate SDK/dispatch content below. Not a full rewrite. |

---

## 1. `examples/offload-fanout/` — the headline §7 demo

A self-contained example proving the whole V1 promise in one place. Models its
structure on `examples/orchestrator-offload` (the existing real-container example):
`package.json` + `src/index.ts` + workspace deps, run via `pnpm start:env` (reads
`../../.env` for `ANTHROPIC_API_KEY`).

### 1.1 `agora.config.mjs` — the repo's first real config
The CLI (`agora orch`, offload-surface) resolves `agora.config.{ts,js,mjs}` for both
`getClient` and the new `getOrchContext`. This example provides the first such file —
exercising that resolution end-to-end. It exports:
- **`default` / `client`**: a wired `AgoraClient` (local-docker compute, `LocalStorageProvider`, `LocalSecretStore`, the `ANTHROPIC_API_KEY` as a deploy-time executor secret — never in a WorkItem, per §10.6).
- **`orch`**: the `OrchContext` — `{ transport: MailboxSubmissionTransport(LocalDirMailbox(dir)), storage: client.storage, anchor: LocalAnchor(store), verifySignature?, runService: (signal) => serve({ orchestrator, transport, signal }) }`. The orchestrator is built with the `DispatchExecutor`, the `AuditLog` (so `orchestrator.getAuditExport` works — `serve` publishes the audit export via the orchestrator, no separate `auditStore` param), a `LocalSigner`, the `LocalAnchor`, and the `default` queue (concurrency ≥ 2 so disjoint locks visibly fan out).

### 1.2 Fixture workspace + subagents
- A tiny **fixture workspace** (a few source files containing a symbol to rename, plus a shared file like `package.json`/manifest) the code-edit subagents operate on.
- A registered **code-edit subagent** (plain registered subagent per §1.2 of V1 — not the deferred `dev` pack shapes): system prompt instructs "rename symbol `OLD` → `NEW` in the file named in your input; change nothing else." On finish, offload-escape captures the workspace diff → patch artifact → `result_ref`.
- A registered **verify subagent**: greps for the renamed symbol / runs a check; non-zero exit gates the run.

### 1.3 `plan.json`
A `Run` shaped to demonstrate safe parallelism (§7):
- One **edit item per fixture file**, each declaring `resourceLocks: [<that file>]` → disjoint locks fan out to the queue's concurrency.
- One edit touching the **shared file** with a lock on it → serializes against anything else touching it.
- One **verify item** with `depends_on` every edit item.

### 1.4 `src/index.ts` (runnable demo) + `README.md`
`src/index.ts` is the one-command demo: start `serve` (in-process), `submit` the plan
(non-blocking, prints run id), `watch` the tree advance wave-by-wave with blocking
reasons, fetch each edit's `result_ref` patch, then assemble + print the
`agora orch audit` evidence bundle — its verification report passing and **naming the
anchor + guarantee tier**. `README.md` shows the operator-facing CLI story
(`agora orch serve | submit plan.json | watch <id> | audit <id>`).

---

## 2. CI deterministic acceptance test (no Docker, no API key)

`examples/offload-fanout/test/fanout.test.ts` (vitest — examples already run tests in
this repo's workspace gate). Uses a **fake/no-LLM executor** that deterministically
emits a patch artifact + a signed-shape manifest per item, run through the **real**
`AgoraOrchestrator` + `OperationsApi` + `AuditLog` over the **same `plan.json`** so the
assertions are genuine end-to-end orchestration:

- **Locks:** items with disjoint locks run within the same wave (fan-out); the
  shared-lock item serializes (never concurrent with another holder).
- **Deps:** the verify item does not fire until all edits are `done`.
- **Escape:** each edit item exposes a `result_ref`.
- **Audit:** `OperationsApi.audit(runId)` → bundle `report.intact === true`,
  `claim === 'tamper-detecting'` (LocalAnchor), names the anchor; manifests carry
  **refs only** — a grep of the serialized bundle for a seeded secret **value** finds
  nothing.
- **Tamper:** mutating one persisted audit entry → `report.intact === false`.

This is the CI-enforceable half of §7 (the spec's "mutating any persisted entry makes
verification fail" + "the bundle contains no secret values").

---

## 3. BSL packaging (§8, decision L1)

- **Root `LICENSE`** — replace FSL-1.1-MIT with **Business Source License 1.1**,
  parameterized: Licensor **Quarry Systems**; Licensed Work **Agora (this
  repository)**; Additional Use Grant **all use permitted except offering Agora, or a
  derivative, to third parties as a hosted or managed orchestration / agent-dispatch
  service**; **Change Date 2030-06-01** (four years); Change License **Apache-2.0**.
  (BSL requires a fixed Change Date; 2030-06-01 is the v0.0.0 placeholder under the
  "4 years from publish" policy, stated in `LICENSING.md`.)
- **`"license": "BUSL-1.1"`** (the SPDX identifier for BSL) added to the root
  `package.json` and every package's `package.json` (all workspace packages).
- **`LICENSING.md`** — plain-language summary: "source-available; self-host and build
  on it freely; you may not resell it as a hosted/managed service until it converts to
  Apache-2.0 on the Change Date."
- The `8e33e4e` changelog's FSL line is updated to record the switch to BSL.

## 4. Docs reframe (§8 messaging, decision L5)

- **`README.md`** — reframe the top: lead with the **security + deterministic,
  tamper-evident auditable execution** edge (§0.1 thesis), state **"source-available
  (BSL)"** (never "open source"), and add an **Offload** section pointing at
  `examples/offload-fanout` with the `agora orch` command flow. Keep the existing,
  still-accurate SDK/dispatch/provider-seam content below the new framing.
- **`docs/sandboxing-ai-agents.md`** — update the launch write-up: "source-available
  (BSL)"; ensure all copy honors §6.1 honesty — **"compliance-ready"** (never
  "compliant"/"certified"), **"tamper-evident"** only at `external-immutable`
  (else "tamper-detecting"), no "reproducible AI output."

---

## 5. Out of scope (this wave)

The Fargate+S3 parity *run* (operator-verified, L4 — the example is written swap-ready
but the live cloud run is not a wave gate); the V1.1 layer (typed `output.json`,
`Intent`/interpreter, `dev` pack shapes, cost budgets, `cron`, `Authorizer`,
BYOK/KMS, Bedrock adapter); `WitnessAnchor`. The example uses plain registered
subagents, not the deferred `dev.code-edit`/`dev.verify` shapes.

## 6. Honesty constraints (carried from §0.1 / §6.1 — enforced in copy + tests)

- All public copy says **"compliance-ready"**, never "compliant"/"certified".
- **"tamper-evident"** only licensed at `external-immutable`+; the local demo (LocalAnchor)
  reads **"tamper-detecting"** — asserted in the CI test.
- No claim of reproducible AI *output* (environment + inputs are reproducible by hash; output is recorded).
- "source-available (BSL)", never "open source" (BSL is not OSI-approved).
