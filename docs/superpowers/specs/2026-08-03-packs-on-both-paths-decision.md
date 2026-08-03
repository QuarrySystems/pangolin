---
title: Packs, the Two Dispatch Paths, and What Is Marooned in the Orchestration Layer — Decision Spec
date: 2026-08-03
status: **OPEN QUESTION — A is unblocked; B and C are unevidenced.** First consumer answered §7 on 2026-08-03: orchestrator-only, asks not to be counted as evidence for both-paths. A stands on §2 (layering), not on both-paths coverage.
branch: spec/packs-on-both-paths
authors: [human:Brett, agent:claude-opus-5]
severity: n/a (architecture question; nothing is broken by today's behaviour, but one consequence is already recorded)
related:
  - ../../../docs-site/src/content/docs/explanation/decisions/0018-orchestration-ships-as-a-layer.md # the governing ADR
  - ./2026-05-28-agora-orchestrator-design.md # where SubagentShape and contextShape were introduced
  - ../../../deploy/serve-stack/KNOWN-ISSUES.md # 17a (contextShape is read by nothing)
---

## 1. The question as originally posed

*"Packs should be usable by either dispatch path — this might be an oversight."*

**It is not an oversight.** ADR-0018 (accepted 2026-06-01) decides it explicitly:

> Orchestration lives in its **own package** `@quarry-systems/pangolin-orchestrator`,
> with its seams + types in `src/contracts/` — **not** in `pangolin-core`, which stays
> minimal (D11). **Low-level providers and the worker remain ignorant of orchestration.**
> …The client `dispatch()` surface is **unchanged** — still one-shot and stateless.

Packs (`SubagentShape`, `PackRegistry`, `validateRun`) are orchestration-layer
governance by design. A `fire()` consumer not getting them is the ADR working as
intended, not a gap someone forgot to close.

**But the instinct behind the question is sound, and points at something sharper.**

## 2. The sharper question: are the right things *in* packs?

ADR-0018's own principle — the worker stays ignorant of orchestration — implies a
test for every field on `SubagentShape`: **does the orchestrator act on it, or does
the worker?** Applying that test:

| Field | Who must act on it | Correctly placed? | Enforced today? |
|---|---|---|---|
| `id` | orchestrator (pack-scoped identity) | yes | yes |
| `effectTier` | orchestrator (feeds the authorizer) | yes | yes |
| `inputSchema` | orchestrator (validates `WorkItem.inputs`) | yes | yes |
| `outputEdgeType` / `inputEdgeTypes` | orchestrator (DAG edge wiring) | yes | yes |
| `outputSchema` | **worker** — its own comment says "enforced via `.pangolin/output.json` in PR6" | **no** | no |
| `capability.imageDigest` | **worker/provider** — which image runs | **no** | no (17a) |
| `capability.permissions` | **worker/provider** — capability-scoped policy | **no** | no |
| `capability.contextShape` | **worker** — what the workspace stages | **no** | no (17a) |

**The pattern is exact and not a coincidence.** Every field the orchestrator acts on
is enforced. Every field the *worker* would have to act on is inert — all four of
them. They are not unenforced because someone forgot; they are unenforced because
they live in a package ADR-0018 requires the worker to be ignorant of. **The layer
holding them structurally cannot enforce them.**

So the real finding is not "packs should span both paths." It is: **four fields are
marooned — worker-concern data parked in the orchestration layer, where nothing can
act on it.** `contextShape` is simply the one we noticed first, via 17.

## 3. What a `fire()` consumer actually loses

Distinguish the two, because they have different answers:

**Genuinely orchestration-only, and correctly so** — a `fire()` caller is composing
its own control flow and owns these itself:

- `inputSchema` validation of work-item inputs
- typed-edge checks between DAG nodes (there is no DAG)
- run-state, retries, resource locks

**Governance that arguably should not be path-dependent:**

- **The authorization gate.** `authorize()` is called at `tick.ts:191` and
  `orchestrator.ts:177` — both orchestrator. A `fire()` dispatch is never gated.
  This is *already recorded* as a live consequence: a consumer's direct-dispatch
  path bypasses the deny gate entirely, and its gating is its own code.
- **`effectTier`.** The declared blast-radius class of a piece of work is arguably a
  property of the work, not of who scheduled it.

The first list is settled. The second is the open question, and it is narrower than
"packs on both paths."

## 4. Why this matters right now

The staged-context design (`contextShape`) has to choose a home. Two candidate
homes, and ADR-0018 picks the winner:

- **On `SubagentShape`** — orchestrator-only. Enforcement would be invisible to
  `fire()`, reproducing exactly the authorizer split above. Also violates D11: the
  worker cannot see it, and the worker is the only thing that can check a workspace.
- **On capability bundles + the subagent def** — both core/client concepts, fetched
  by the worker on *every* dispatch via `bundle-fetcher` (`{subagentDef,
  capabilities, envs, inputs, pipeline}`). The worker already consumes
  `subagent.{systemPrompt, promptTemplate, model}` from that def.

The second is not a workaround for ADR-0018 — **it is what ADR-0018 prescribes.**
`contextShape` on `SubagentShape` is the layering error; moving it corrects one of
the four marooned fields.

## 5. Options

**A — Leave the split; fix the marooning, field by field.** Accept that packs are
orchestration-only. Relocate each worker-concern field to a home the worker can
read (`contextShape` → capability manifest + subagent def; `imageDigest` → the
executor config that already carries `workerImage`; `outputSchema` → the sentinel
contract; `permissions` → the secret/provider seam). *Fully consistent with
ADR-0018. Does nothing for the authorizer gap.*

**B — A plus: lift the authorization gate below the split.** Move `authorize()` to a
seam both paths cross, so a `fire()` dispatch is gated too. *Closes a recorded
consequence. Touches the client's one-shot contract, which ADR-0018 froze — so it
needs that ADR amended or a narrow carve-out, not a quiet change.*

**C — Make packs available on both paths.** Export the registry and run shape
validation client-side before `fire()`. *Gives `fire()` consumers schema validation
and effect tier. Contradicts D11 unless the validation lives in core rather than the
orchestrator, which means moving `SubagentShape` into `pangolin-core` — a large
change to a published surface, and it re-introduces exactly the "core stays minimal"
pressure ADR-0018 pushed back on.*

**Recommendation: A now, B as its own decision, C only on real demand.** A is
strictly corrective and unblocks the staged-context work. C should not be built on a
guess — §7.

## 6. What must not be lost

- **ADR-0018 is accepted and this spec does not reopen it.** The layering is
  deliberate. What is in scope is whether specific fields are on the correct side of
  a line the ADR already drew.
- **`fire()` staying one-shot and stateless** is load-bearing for consumers who do
  not want a service. Option B in particular must not smuggle state into it.
- **The `capability` block is inert today**, so relocating its fields breaks no
  behaviour — there is none to break. That makes A unusually cheap for its value.

## 7. Evidence — asked and partly answered (2026-08-03)

The open half (B and C) turns on whether a real consumer dispatching via `fire()`
wants pack governance. Asked directly. **The first consumer's answer removes them as
evidence, in either direction:**

> Verified: no `pangolin-client` import anywhere in remora. `sync/register.ts` says
> it's "deliberately not an import." I've never called `fireWork`/`dispatchWork`. So
> I get zero benefit from the both-paths design. Don't count remora as a reason to do
> it — if covering `fire()` complicates the orchestrator path, that's cost I pay for
> benefit I don't receive. If you have another consumer on `fire()`, decide on their
> evidence, not mine.

Three consequences, and the third is the one to be careful about:

1. **B and C have no demand behind them today.** Not "rejected" — unevidenced. They
   stay open pending a `fire()`-path consumer, and this consumer explicitly asks not
   to be counted as one.
2. **C acquires a stated cost.** An orchestrator-only consumer pays any complexity
   that both-paths coverage adds to the orchestrator path, for benefit they do not
   receive. C now needs to show it does not do that.
3. **This does NOT change option A, and the distinction matters.** A's placement
   argument never rested on both-paths coverage. It rests on §2: the worker is the
   only thing that can observe a workspace, and per D11 the worker cannot see
   `SubagentShape`. That argument is unaffected by which paths a consumer uses — an
   orchestrator-only consumer still needs the *worker* to do the checking. Do not
   read "remora is orchestrator-only" as "so put it back on `SubagentShape`."

Question 3 — whether the missing `fire()` authorization gate has been *hit* rather
than merely being bypassable — remains unanswered by a consumer who does not use
that path. B still waits.

## 8. Not in scope

- Reopening ADR-0018.
- The staged-context vocabulary and verification design — that is its own spec; this
  one only settles *where* it may live.
- Any change to `PangolinClient.dispatch()`'s signature.
