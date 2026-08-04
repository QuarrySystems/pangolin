---
title: Staged-Context Verification — Design
date: 2026-08-03
status: **SHIPPED — status corrected 2026-08-03.** Verified on main: `context-check.ts + context-requirement.ts, shipped in #152`. This line previously read "**DESIGNED — ready for a plan.** Scope inverted from the first draft on consumer evidence (see §2). v1 is verification only; declaration and rendering are v2 and are gated on v1 existing.", which was stale: the work landed and the marker was never updated. **Originally:** **DESIGNED — ready for a plan.** Scope inverted from the first draft on consumer evidence (see §2). v1 is verification only; declaration and rendering are v2 and are gated on v1 existing.
branch: spec/staged-context-verification
authors: [human:Brett, agent:claude-opus-5, consumer:remora]
severity: medium (no control is falsified; a documented field is inert and a real failure class is misattributed)
related:
  - ./2026-08-03-packs-on-both-paths-decision.md # why this lives where it does (option A)
  - ../../../deploy/serve-stack/KNOWN-ISSUES.md # 17, 17a, 17b, 19a
  - ../../../docs-site/src/content/docs/explanation/decisions/0018-orchestration-ships-as-a-layer.md # D11
---

## 1. Problem

`contextShape` is declared in five places and read by none (17a). A dispatched agent
is told what its workspace contains only by an author-written brief, and **nothing
detects when that brief goes stale.** The consumer states the failure precisely:

> Those 22 statements were true when written. The moment `toolchain-bce5a07ef85a` is
> bound, all 22 become false, and nothing detects it. An agent told "pnpm cannot run
> here" will not run it when it can — and I'd never know, because the brief is prose
> nobody checks.

The agent is **not** under-informed. Briefs are more explicit than any generated
manifest. The defect is **drift between a static claim and a workspace that changed.**

## 2. Scope, and why it inverted

The first draft proposed supply-declaration plus prompt-rendering first, with
verification optional. **The consumer inverted it, and the argument is structural:**

> A declaration nobody checks is exactly the failure mode this area keeps producing —
> `contextShape` is a sentence with five declaration sites and no reader; my own
> `expectedExecutions` recorded one capability while binding two; a stable agent name
> pointed at three different content hashes. Shipping supply-declaration without
> verification adds a **sixth unread declaration to a system whose problem is unread
> declarations**.
>
> If v1 must be one half, make it needs + verification and skip rendering. I'll keep
> hand-writing briefs; **I can't hand-write detection.**

Accepted in full.

- **v1 — verification only.** A subagent declares what it needs; the worker checks
  the real workspace and fails before the agent runs.
- **v2 — declaration + rendering.** Only ships behind v1. Rendering an *unverified*
  declaration replaces N unchecked prose claims with one unchecked JSON claim, which
  is a net loss.

## 3. Non-goals — stated plainly, because 17's framing invited the conflation

**This does not give a verifier the base tree, and does not verify "patch applied."**

Issue 17 bundled two problems: a verifier that cannot see the base tree, and nobody
being able to run a toolchain. **This design solves the second only.** "Patch
applied" is excluded because it is not verifiable post-hoc — checking it requires the
diff and the base, which is re-doing the apply, not observing a property. The
consumer confirms this is the half they most want and that it remains open:

> You've correctly excluded "patch applied" as unverifiable — and that is precisely
> what my verifier needs… This proposal solves the second and not the first.

Also out of scope: reopening ADR-0018, changing `PangolinClient.dispatch()`, and the
other three marooned fields (`outputSchema`, `imageDigest`, `permissions`).

## 4. Design

### 4.1 Where it lives, and why

`contextRequires?: ContextRequirement[]` on the **subagent definition** — the
free-form `def` built at `subagent-register.ts:70`, stored content-addressed, and
fetched by the worker on every dispatch via `bundle-fetcher`
(`{subagentDef, capabilities, envs, inputs, pipeline}`). The worker already consumes
`subagent.{systemPrompt, promptTemplate, model}` from it.

**Not on `SubagentShape`.** Per D11 the worker is ignorant of orchestration, and the
worker is the only thing that can observe a workspace. This is option A of the packs
decision spec — correcting a layering error, not routing around one.

**This placement does not rest on both-paths coverage.** The first consumer is
orchestrator-only and asked not to be counted as evidence for that. The argument is
purely that the checker must be able to read the requirement.

### 4.2 Vocabulary — observable only

```ts
export type ContextRequirement =
  | { kind: 'paths'; glob: string; minCount?: number }  // files exist in the workspace
  | { kind: 'exec'; bin: string }                       // resolvable on PATH
  | { kind: 'git'; needs: 'history' | 'worktree' };     // .git usable
```

Each is answerable by observation alone, and none names an ecosystem. Consumer
confirms sufficiency:

> files-at-glob / executable-on-PATH / git-history-reachable cover every case I've
> hit: `node_modules` present, `pnpm` resolvable, history for a dispatched
> coordinator. I can't name a fourth I'd use, and I'd rather say that than invent one.

Deliberately absent: anything asserting *intent* ("patch applied", "snapshot at
revision"). If it cannot be observed, it is not in the vocabulary.

### 4.3 Where the check runs

Between step 9 (`pangolin-setup.sh`) and step 11 (agent), beside `captureBaseline`
(`entrypoint.ts:514`).

**After setup is a hard ordering constraint, not a convenience:** `setup.sh` is what
installs the toolchain (17b), so an `exec` requirement is unanswerable before step 9.

### 4.4 Failure — and the rationale, corrected

On any unmet requirement: `dispatch.failed`, `reason: 'worker-failed'`, `detail`
naming **which** requirements were unmet and what was observed instead.

**The reason is misattribution, not false greens.** The first draft justified this as
preventing a verifier from reporting success it did not earn. That is not what
happened to the consumer:

> The two `tsc` errors did not come from a verifier producing a false green. They came
> from a verifier answering a narrower question than compilation, because I wrote
> criteria I knew it could check. The green was true against the criterion given. I
> lowered the question rather than getting a wrong answer to it.
>
> …The real failure is misattribution, and 17b measured it — when the PATH half is
> missing, the agent gets `command not found`, which reads as a plan problem. I lost a
> cycle to exactly that class with a NUL in a plan: the report said "no item id
> resolves to …-impl" and the actual cause was four layers away.

So the value is: **an unmet requirement discovered at agent time gets blamed on the
wrong thing.** Failing at the check point names the real cause at the point it is
knowable. This matters for aim — justified by false-greens, the feature points at
verifiers; justified by misattribution, it points at every dispatch.

The consumer reached the same conclusion independently, before seeing this proposal
(`worker-toolchain` criterion 4): *"a run that installs but cannot resolve the binary
counts as a failure, not a partial success."*

## 5. v2 — declaration and rendering

Deferred, and specified here only so v1 does not foreclose it.

**Why it is still worth doing:** a *generated* declaration cannot go stale, which is
the drift in §1. Rendering is valuable for that reason, not because the agent learns
something new.

Two constraints the consumer identified, both of which the first draft would have got
wrong:

**Declaration must be optional, and absence must mean "declares nothing".**

> My `work-<treeDigest12>` is produced per cycle by `pnpm snapshot` from `git archive`
> — 200+ files. What would its `pangolin-context.json` say? `files-at-glob: **` is
> vacuous. A static `toolchain-*` bundle declaring "provides pnpm on PATH" is natural;
> a repo snapshot declaring its own contents isn't.

So absence means *"this bundle declares nothing"*, **never** *"this bundle stages
nothing"* — otherwise every generated bundle needs a declaration generator emitting
noise.

**Array-union is the wrong merge rule, and it compounds an existing silent drop.**

`pangolin-setup.sh` is `last-write-wins` (`overlay-engine.ts:44`): if two bundles
ship one, the loser vanishes with no error. Layering array-union declarations on top
produces a declaration asserting **both** scripts while only one ran.

> Union is right for additive things; two bundles declaring conflicting supply of the
> same path should refuse, not merge.

v2 therefore needs a collision rule — conflicting supply for the same path **refuses
the dispatch** — and should treat the existing `last-write-wins` silent drop as a
defect in its own right rather than building on top of it.

## 6. Acceptance criteria

1. A subagent with `contextRequires: [{kind:'exec', bin:'pnpm'}]` dispatched into a
   workspace where `pnpm` is **not** resolvable fails with `reason: 'worker-failed'`,
   and the detail names `pnpm`. Asserted through a real `runWorker` lifecycle, not a
   synthetic env object — every existing call site passes a synthetic one, so a test
   written the usual way is vacuous.
2. The same subagent, with a `pangolin-setup.sh` that installs `pnpm` into `$HOME`
   **and** an env bundle putting it on `PATH`, **succeeds** — proving the check runs
   after step 9 and that both halves of the 17b recipe are what satisfy it. This is
   the positive control for criterion 1.
3. A `paths` requirement is satisfied by a file delivered via a capability bundle, and
   separately by one materialized at `inputs/<key>` from an `inputRef` — the check
   observes the workspace and is indifferent to how bytes arrived.
4. A `git` requirement with `needs: 'history'` is satisfied by a bundle carrying
   `.git` (19a) and unsatisfied by a workspace without one; both asserted in the same
   test so the failure is not an artifact of a broken probe.
5. A subagent with **no** `contextRequires` behaves exactly as today — no check, no
   new failure path, and an existing dispatch's content hash is unchanged (the field
   is additive and hash-stable only when absent, matching the `verify` precedent at
   `subagent-register.ts:78`).
6. The failure occurs **before** the agent is invoked: a stub adapter records zero
   invocations on the failing run, while the passing run records one. The passing run
   is the control.
7. `pnpm -r lint` / `pnpm -r typecheck` clean; existing subagent-register and worker
   tests pass unmodified.

## 7. Open risks

- **A new failure path.** Every dispatch with `contextRequires` gains a way to die
  that did not exist. Mitigated by the field being optional and absent by default, but
  an over-strict requirement blocks legitimate work — and unlike the deps-evidence
  sentinel, this one is *meant* to be fatal.
- **`git` requirement semantics on a synthetic repo.** `captureBaseline` runs
  `git init` in the workspace (`patch-capture.ts:19`), so *after* it a `.git` always
  exists. The check runs **before** `captureBaseline`, which is what makes
  `needs: 'history'` meaningful — but the ordering is load-bearing and a later
  refactor that moves either call breaks the check silently. A test should pin the
  order, not just the outcome.
- **The base-tree half stays open** (§3). This design should not be read as closing
  issue 17.
