---
title: Mneme Agent-Memory Integration — Design Spec
date: 2026-06-19
status: draft
branch: feat/authorizer-seam (spec authored here; implementation lands on its own branch)
authors: [human:Brett, agent:claude-opus-4-8]
related:
  - ./2026-05-28-agora-orchestrator-design.md  # §2 Claim reservation for Mneme
  - C:/Users/brett/source/repos/My_Projects/Mneme/mneme-spec-v0.2-consolidated.md
---

# Mneme Agent-Memory Integration — Design Spec

> **One line:** Give dispatched workers durable, project-scoped memory by having the
> **orchestrator broker** `recall`/`remember` against **Mneme** at fire/reconcile —
> the worker never touches the store. Technical-only memory in v1; the regulated-data
> stack is reserved behind a named seam.

This is the first of the three Mneme integration shapes considered (agent memory,
claim-backed audit/provenance, knowledge pack). It was chosen as the first integration
because it delivers the obvious "agents remember across runs" value, uses the loosest
coupling that fits pangolin's isolation model, and does not touch the audit trust root.

---

## 1. Context & motivation

Today every dispatch is hermetic: the worker boots a fresh claude-code runtime in a
sandbox (local Docker or Fargate), runs, seals a manifest, and dies. Nothing a sub-agent
*learns* survives — the same flaky path is rediscovered run after run.

**Mneme** (`C:/Users/brett/source/repos/My_Projects/Mneme`) is a deterministic,
append-only, confidence-scored claims store (`subject`/`key`/`value` + confidence,
bitemporal validity, supersession-only conflict model). It runs as both an embeddable
library and a stdio MCP server, persists to SQLite, and was recently tuned with
recency-aware ranking (α=0.5/half-life-90d) for exactly the "surface the latest lesson"
read pattern.

The orchestrator design spec (`2026-05-28-agora-orchestrator-design.md` §2) **reserved
the `Claim` core type for Mneme** and mandated that any claim shape align with Mneme's
model rather than inventing a divergent one. This spec is the first consumer to act on
that reservation — but deliberately *without* pulling `Claim` into `pangolin-core` yet
(that is the knowledge-pack integration, a separate, larger effort).

## 2. Goals & non-goals

**Goals**
- Dispatched workers accumulate institutional memory **across runs**, scoped to the
  target repo/project.
- Zero new network/egress surface on the sandboxed worker.
- Every memory access is auditable and rides existing audit/seal rails.
- Compliance-ready posture for HIPAA / SOC2 / GDPR / EU AI Act / EU Data Act —
  meaning the architecture never blocks a customer's certification.

**Non-goals (v1)**
- Interactive, mid-task memory (worker querying memory N times while reasoning).
  v1 gives a recall snapshot at fire and one write at reconcile.
- Storing personal/regulated data (PHI/PII/case-subject data) in memory. v1 is
  technical-only and enforces that boundary.
- Pulling `Claim` into `pangolin-core`. That waits for the knowledge-pack consumer.
- Run-scoped DAG-blackboard corpora. Reserved as a fast-follow (see §10).

## 3. Architecture — the broker model

The worker **never talks to Mneme.** The orchestrator mediates, reusing the existing
fire/reconcile split, S3 inbox/outbox handoff, and manifest sealing.

```
FIRE       orchestrator.recall(corpus, about)  ──▶  memoryRef (sealed inputRef)  ──▶  worker
                                                                                       │ does work,
                                                                                       │ emits claims[]
RECONCILE  worker result { outputs, claims[] }  ──▶  orchestrator.remember(corpus, claims)
```

- **At fire:** the orchestrator runs `recall` and injects the result into the dispatch
  as a content-addressed input — exactly like a typed-product `inputRef`
  (`pangolin-core/src/audit.ts` `DispatchManifest.inputRefs`). The recalled memory is
  sealed into the manifest, so "what memory informed this run" is tamper-evident.
- **At reconcile:** the worker emits proposed claims in a structured slot of its result
  (an `outputRef`-style channel). The orchestrator harvests them, runs them through the
  write-path policy (§7), and commits the survivors via `remember`.

**Why the broker model (rejected alternatives):**
- *Co-located sidecar* (Mneme MCP inside the worker container, DB hydrated from S3):
  reintroduces cross-container SQLite concurrency/merge problems and widens the sandbox
  with a live stateful service. Rejected for v1; revisit only if interactive memory
  becomes a hard requirement.
- *Networked shared Mneme service*: directly contradicts the isolation model (egress +
  shared stateful service across tenants) and Mneme is stdio-only anyway. Off the table.

**Three properties the broker buys:**
1. **No new worker surface.** The sandbox stays hermetic; recall is just sealed input,
   remember is just harvested output.
2. **Single writer.** The orchestrator is the only process touching Mneme, which sidesteps
   Mneme's single-machine-SQLite cross-container concurrency limitation entirely.
3. **Auditable by construction.** recall/remember become audit-chain events (§7).

## 4. Coupling & dependency strategy

Mneme is consumed **library-mode, orchestrator-side** (in-process `createMneme`), not over
MCP — the broker is in the orchestrator's own trusted process, so an MCP round-trip per
seal is unnecessary overhead.

**Dependency gap (must resolve before implementation):** Mneme is **not consumable as a
published package** — npm has a stale `0.1.1-alpha.2` from a different maintainer; the real
`0.2.0` lives only in the repo (currently on a feature branch; `main` is clean). Pangolin
consumes `@quarry-systems/*` published packages. Resolution options, in preference order:
1. **Publish Mneme** under the `@quarry-systems` scope and depend on it normally.
2. **Git-pin** to a Mneme commit until it is published.
3. Vendor (last resort).

Mneme's native dependency (`better-sqlite3`) lands only in the **orchestrator/broker**
process, never in the worker image — another reason the broker model is the right coupling.

## 5. Corpus scope (v1)

`corpus = project:<target-repo>` — durable institutional memory that compounds run-to-run.
This is the highest-value scope, matches what Mneme's recency ranking was tuned for, and
keeps v1 to a single scoping rule.

**The corpus is the hard isolation boundary** (standing invariant — see §8). A dispatch may
only ever touch corpora its grant authorizes. There is no global corpus, ever.

## 6. Access control — `MemoryAccess`

A per-grant capability, **default-deny** (matching the worker env-firewall posture).

**Naming.** Called `MemoryAccess`, not `*Tier`: in this repo `*Tier` denotes an *assurance*
dimension reported in the `VerificationReport` (`AuthzTier`, `TimeTier`), whereas this is a
*granted capability*. Keeping the two registers distinct prevents drift.

**Home.** `MemoryAccess` attaches to the existing
`SubagentShape.capability.permissions: Record<string, unknown>`
(`pangolin-orchestrator/src/contracts/subagent-shape.ts`) — the established extensibility hook —
not a new grant type. (See §6.2 for the bedrock alternative.)

| Tier | Recall | Remember |
|---|---|---|
| `none` *(default)* | — | — |
| `read-only` | grant corpus | — |
| `write-ephemeral` | run + grant corpus | run-scoped (dies with run) |
| `write-durable` | run + grant corpus | durable project/grant corpus |

`MemoryAccess` gates *whether* a dispatch may read/write; §7's belief-weighting governs *how
much* a write is trusted once stored. (`write-ephemeral` is wired in the schema but the
run-scoped corpus it targets is a fast-follow — see §10.)

### 6.1 Composition with `EffectTier` (not a parallel gate)

Memory operations are dispatch effects under the existing `EffectTier`
(`pure | read-impure | write-impure`, `pangolin-orchestrator/src/contracts/types.ts`):
`recall` is **read-impure** (triggers the existing live-state snapshot); `remember` is
**write-impure** (gated by the existing intent policy and sealed into the manifest
`effectClass`). `MemoryAccess` declares the *capability*; `EffectTier` + intent policy provide
the *runtime effect gating*. The two compose — committing a durable claim requires BOTH
`MemoryAccess: write-durable` AND a passing write-impure intent check. `MemoryAccess` MUST NOT
reimplement effect gating.

### 6.2 Candidate canonical home — bedrock (decision deferred)

`@quarry-systems/bedrock-*` is the org's authorization engine: a `Permission` is an
`(action, resourceType, resourcePattern)` tuple over a `Subject` (subjectType includes `agent`)
within a `Scope`, with conditional (JSON-Logic) grants and explicit `grant`/`revoke`/`inherit`
edge states. `MemoryAccess` maps onto it directly — `action ∈ {recall, remember}`,
`resourceType = Memory`, `resourcePattern = the corpus` (`project:<repo>` durable vs
`run:<id>` ephemeral), `scope` = the isolation boundary. Adopting bedrock would replace both the
bespoke enum AND pangolin's not-yet-materialized grant schema with a published, reusable model,
and prevent a fourth parallel authz vocabulary across the org (pangolin `Authorizer`, stoa
`Principal`/`ToolScope`, bedrock, this).

**But** it intersects pangolin's just-shipped `Authorizer`/`Authorization` seam and
`pangolin-core`'s zero-dependency rule, so it is a *foundation-level* decision bigger than this
feature (Open Q5, §11). v1 ships `MemoryAccess` as specified above; if bedrock is later adopted
as pangolin's authorization foundation, `MemoryAccess` collapses into a bedrock `Permission`
with no change to the broker, corpus, or compliance design.

## 7. Trust, belief weighting & the compliance layer

### 7.1 Source-trust on writes
Harvested agent claims are committed at Mneme's `llm` source-trust weight (0.7, from Mneme
spec §4.9: manual 1.3 / verification 1.2 / workflow 1.0 / heuristic 0.9 / llm 0.7 /
imported 0.6). Autonomous-agent memory is therefore automatically discounted and can never
outrank human-curated knowledge in recall. **Open tunable:** reuse `llm` (0.7) or introduce
a lower `dispatched-agent` weight.

### 7.2 The `MemoryDataPolicy` seam
A named seam (interface + impls, following the `SecretStore` precedent) that governs what may
enter a corpus. v1 ships exactly one impl; the heavy one is reserved per the "second consumer"
discipline.

- **`technical-only` (v1, shipped):** **scan-and-reject PII/PHI on the write path**, extending
  the existing credential scanner. A proposed claim that names a person, case/claim number,
  SSN, DOB, or medical/financial detail is rejected (and the rejection is logged, redacted).
  Allowed: operational/technical lessons (e.g. "this repo: rebuild dist before trusting
  missing-export failures").
- **`regulated` (reserved, NOT built):** crypto-shredding (per-subject keys), GDPR Art.17
  erasure path, write redaction, data residency, retention/disposal. Built only when a use
  case forces it.

### 7.3 Compliance controls (first-class in v1)

| Control | v1 behaviour | Framework served |
|---|---|---|
| `MemoryDataPolicy` (`technical-only`) | scan-and-reject PII/PHI on write | GDPR (keeps personal data out); seam reserves the Art.17 path |
| Audit-chain memory events | every `recall`/`remember` → new `AuditEntry` kinds `memory.recalled` / `memory.remembered` | SOC2 audit · HIPAA §164.312(b) · EU AI Act traceability/record-keeping |
| Encryption at rest | Mneme store encrypted with a per-grant key (also pre-wires future crypto-shredding) | SOC2 confidentiality · HIPAA |
| Corpus export | per-grant corpus exportable in an open format (Mneme is replayable) | EU Data Act portability/access |
| Retention | corpus TTL + disposal policy, distinct from Mneme confidence decay | GDPR storage limitation |

**Key compliance property:** because v1 stores no personal data, GDPR erasure/residency do
not *bite* — the PII scanner is the GDPR control (it enforces the boundary), and the
`MemoryDataPolicy` seam makes adding regulated-data support a documented extension, not a
rewrite. "Compliance-ready" here means architected so a customer's HIPAA/SOC2/EU certification
is never blocked — certification itself is org + process, not code.

> **Append-only vs. right-to-erasure (recorded tension).** Mneme is supersession-only and
> never deletes; GDPR Art.17 and HIPAA disposal require actual deletion. v1 sidesteps this by
> storing no personal data. The `regulated` `MemoryDataPolicy` impl MUST resolve it via
> crypto-shredding (destroy the per-subject key) and/or a hard-delete tombstone before any
> regulated data is ever stored. This is the single most important constraint on the reserved
> stack.

## 8. Standing invariants (always on, not tiers)

1. **Recalled memory is untrusted input.** It is injected as data, labeled as a
   prompt-injection vector, regardless of tier. A tier governs scope/capability, never whether
   to trust content.
2. **Corpus = the hard isolation boundary.** No cross-corpus read/write without an explicit
   grant; no global corpus.

## 9. Components, error handling & testing

**Components (proposed):**
- `pangolin-memory` package (follows the `pangolin-secret-store` seam precedent): the broker
  interface + the Mneme-backed impl + an in-memory test impl + the `MemoryDataPolicy` seam with
  its `technical-only` impl.
- Orchestrator wiring: `recall` at the fire executor; `remember` at reconcile; new audit-entry
  kinds.

**Error handling:**
- A Mneme failure on `recall` is **non-fatal** — the dispatch fires with no memory input (same
  best-effort posture as a TSA outage in the seal path). Logged.
- A Mneme failure on `remember` does not fail the run; the proposed claims are dropped and the
  failure is logged (redacted). The run's primary outputs already sealed.
- A claim rejected by `MemoryDataPolicy` is dropped and logged (redacted) — never partially
  written.

**Testing:**
- Broker unit tests with the in-memory impl (recall→fire→reconcile→remember round-trip).
- `MemoryDataPolicy` scan-and-reject tests: PII/PHI fixtures MUST be rejected; technical
  lessons MUST pass. (Mirror the demo-bundle discipline: each rejection fixture proves it is
  actually rejected.)
- Audit-event tests: recall/remember each emit the correct `AuditEntry`.
- Isolation test: a dispatch cannot read/write a corpus outside its grant.
- Compliance gates run the full local suite (`pnpm -r typecheck` + `pnpm -r test` +
  `pnpm test:e2e` + per-pkg lint) — this change adds audit-entry kinds, a known
  blast-radius class.

## 10. Out of scope / fast-follows
- **Run-scoped (DAG-blackboard) corpora** — `write-ephemeral`'s target. Fast-follow once the
  durable path proves out.
- **Regulated-data `MemoryDataPolicy`** — crypto-shredding/erasure/residency. Built on a real
  consumer.
- **Interactive mid-task memory** — would require the sidecar model.
- **Pulling `Claim` into `pangolin-core`** — the knowledge-pack integration.
- **Claim-backed audit/provenance** (integration shape #2) — derive-only, separate spec.

## 11. Open questions
1. Mneme dependency: publish under `@quarry-systems` vs git-pin for v1? (§4)
2. Source-trust weight for dispatched agents: reuse `llm` (0.7) or add `dispatched-agent`? (§7.1)
3. Per-grant encryption key custody — reuse the KMS path from the seal signing-key work, or a
   distinct key hierarchy? (§7.3)
4. Exact structured slot/shape for worker-proposed claims in the reconcile result. (§3)
5. Adopt `@quarry-systems/bedrock` as pangolin's authorization foundation (so `MemoryAccess`
   becomes a bedrock `Permission`)? Foundation-level — intersects the `Authorizer` seam and
   `pangolin-core`'s zero-dep rule; likely warrants its own brainstorm. (§6.2)
