# Model + cost identity in dispatch evidence — design

**Date:** 2026-06-06
**Status:** approved (brainstorm session, post dogfood run 2); amended same day after a code-grounded audit (8 amendments — see §10 changelog)
**Motivating run:** `dogfood-handoff-run2` (PR #51) — both workers ran `claude-opus-4-7[1m]` by image-default fall-through; the sealed manifests carry `model: { id: '' }`; cost/tokens were discarded. For a product whose pitch is "prove exactly what ran," the evidence could not answer "which model?" or "what did it cost?". Vault: `idea-model-cost-identity-in-the-dispatch`.

## 1. Decisions (locked)

| # | Decision | Choice |
|---|---|---|
| D1 | Pinning posture | **Pin-optional, capture-always.** Nothing fails for lack of a model anywhere in the chain. |
| D2 | Levels abstraction | **Reserved keywords now, no registry.** One opaque `model` string; `fast` / `standard` / `max` are reserved level names every adapter MUST map to its own models; any other value passes through verbatim as a provider-native id. |
| D3 | Default-model config | **`DispatchExecutor` option** (`defaultModel?: string`), so the orchestrator knows the requested model at fire time and seals it. |
| D4 | Verify scope | **Capture-only.** No new verify row. The authorized-vs-actual check is demand-pulled (same posture as the handoff row: evidence first, check when a consumer needs enforcement). |
| D5 | Threading seam | **First-class `model?: string` on `DispatchWork`** — model is part of "what was authorized," like `subagent`. It is NOT an env bundle (env rides as registered `EnvRef` bundles; a per-dispatch scalar doesn't fit that seam). Client→worker it rides the control-plane env (`AGORA_MODEL`, beside `AGORA_DISPATCH_ID` et al., parsed by `env-parser.ts` and stripped from the runtime env by the §7.7 firewall like every `AGORA_*` var); worker→adapter it rides the **existing typed seam** `RuntimeInvocation.model` (`agora-core/src/runtime-adapter.ts:42`, already populated from the subagent def at `pipeline-runner.ts:125`). The adapter never reads model from env. |
| D6 | Per-layer resolution (DRY) | **One rule per layer, no duplicated fallback.** Client passes `work.model` through verbatim (no resolution). Executor owns *authorization*: `def.model ?? defaultModel` → set on `work.model` + sealed in manifest. Worker owns *runtime effect*: `work.model (via AGORA_MODEL) ?? subagentDef.model` — a one-line override on the existing `BlockContext.subagent.model`, zero extra fetches (the worker already holds the def blob). `work.model`-when-set wins everywhere. |

## 2. The `model` string

One field, one grammar, interpreted by the runtime adapter:

- `fast` | `standard` | `max` — portable capability levels. The claude-code adapter maps them to the CLI's bare aliases: `haiku` / `sonnet` / `opus` (aliases resolve to current versions CLI-side; the mapping stays version-free).
- anything else — provider-native model id (e.g. `claude-opus-4-7`), passed to the runtime verbatim.

**Effective requested model** at fire time (executor path): `subagent.model ?? executor.defaultModel ?? unset`. At the worker (any path): `work.model ?? subagentDef.model ?? unset` (D6 — identical outcome on the executor path since the executor already folded the def in). Unset means the adapter passes no `--model` flag and the runtime's own default applies — exactly today's behavior.

A future second adapter (e.g. codex) brings its own three-line level map; plans and subagents written with levels stay portable. No mapping registry, no level-override config until a second adapter pulls them.

## 3. Requested side (orchestrator + client + CLI)

### 3.1 `agora-client` — already done; verify + document

**Audit finding:** registration already carries `model` end-to-end — `RegisterSubagentOpts.model?: string` (`subagent-register.ts:34`, plain TS interface, no zod in agora-client) and the stored canonical def writes `model: opts.model ?? null` inside the content hash (`subagent-register.ts:74`). No code change. Work here is: regression tests asserting the field survives to the blob, and docs (§7).

- `client.dispatch(work)`: passes `work.model` through **verbatim** — no resolution, no def-fallback (D6). `fireWork` emits the new control-plane env var `AGORA_MODEL=<work.model>` beside `AGORA_DISPATCH_ID` et al. (`dispatch.ts:248-275` block) when set.

### 3.2 `agora-cli` — already done; document

**Audit finding:** `agora subagent register --model <id>` already exists, inline and via `--from` YAML (`cmd-subagent.ts:33,41,47,54,62`). Docs only (§7).

### 3.3 `agora-core` — contract changes (both additive; types-only discipline preserved)

- `DispatchWork.model?: string` (`dispatch.ts`). Documented grammar per §2. Non-secret; never redacted.
- `RuntimeExit.usage?` (`runtime-adapter.ts`) — the adapter→worker carrier for captured usage (shape per §4.3). **This was an unstated contract change pre-audit; it is the only way usage crosses the adapter boundary.**

### 3.4 `agora-orchestrator` — `DispatchExecutor`

- New option `defaultModel?: string` alongside `workerImage`.
- **Restructure (audit):** today the `DispatchWork` is built and fired (`dispatch.ts:68-77`) *before* the subagent resolves, and `resolveModel`'s blob fetch is post-fire (`dispatch.ts:88-89, 190-208`). The executor gains a **pre-fire** `resolveLatest` + def-blob fetch; the effective requested model (`def.model ?? defaultModel`) is computed once and reused for BOTH `work.model` and the manifest `model.id` — `resolveModel`'s post-fire fetch is replaced, not duplicated.
- Race caveat (recorded, accepted): pre-fire `resolveLatest(name)` can race a concurrent re-registration relative to the client's own resolve inside `fire`. The invariant this design actually guarantees is **manifest ≡ dispatched work** (both derive from the single pre-fire resolution), not "manifest ≡ whatever blob the worker later fetches" — that stronger check is the deferred verify row's business (§9).
- Manifest schema unchanged (`{ id, temperature, maxTokens }`; temperature/maxTokens stay 0 — claude-code exposes neither per-invocation). Nothing resolved → seals `id: ''` (today's best-effort zero).

## 4. Actual side (worker + adapter)

### 4.1 `agora-worker` — control-plane parse + invocation override

- `env-parser.ts` parses the new control-plane var `AGORA_MODEL` (optional). Like every `AGORA_*` var it is stripped from the runtime env by the §7.7 firewall (`runtime-env-filter.ts:54`) — it never reaches the adapter as env, and no firewall exception is made.
- `entrypoint.ts`/`pipeline-runner.ts`: the effective runtime model is `parsed.model ?? subagentDef.model` — a one-line override where `BlockContext.subagent` is built (the def already carries `model?` at `entrypoint.ts:463-468`; `runAgentBlock` already passes it as `RuntimeInvocation.model` at `pipeline-runner.ts:125`). The worker forwards an opaque string; it never interprets levels (SoC).
- `pipeline-runner.ts`: `runAgentBlock` surfaces `RuntimeExit.usage` from the adapter, and the auto-seal threads it into `writeSentinel` (§4.3).

### 4.2 `agora-runtime-claude-code` — adapter

- Reads `spec.model` from the `RuntimeInvocation` (the typed seam it has ignored until now — `adapter.ts:50-75`). Maps levels via a module constant `{ fast: 'haiku', standard: 'sonnet', max: 'opus' }`; any other value passes through. Result becomes `--model <id>` on the spawn arg list. No `spec.model` → no flag (unchanged). The adapter never reads model from env.
- Spawn switches from `claude --print <prompt>` to `claude --print --output-format json <prompt>`. The adapter parses the result envelope:
  - **Agent text** comes from the envelope's `result` field and MUST be surfaced exactly where raw stdout text is surfaced today (behavior identity for every downstream consumer of the agent's output).
  - **Usage** is extracted: `modelUsage` (object keyed by actual model ids), `total_cost_usd`, `num_turns`, `duration_ms`.
- **Best-effort guarantee:** if stdout does not parse as the expected JSON envelope (older CLI, truncation, crash), the adapter falls back to treating raw stdout as the agent text and reports no usage. Usage capture must never fail a dispatch that would otherwise succeed (same posture as `resolveModel`'s zero fallback).

### 4.3 `agora-worker` — output sentinel

- New optional, additive `usage` block (exact posture of the Wave-A `outputs/` block — absence changes no bytes, presence is additive):

```ts
usage?: {
  models: string[];        // actual model ids that ran (keys of modelUsage)
  costUsd?: number;        // total_cost_usd
  turns?: number;          // num_turns
  durationMs?: number;     // duration_ms (model time, adapter-reported)
}
```

- The block flows into the dispatch evidence the same way `verify` and `outputs` already do, carried from the adapter via `RuntimeExit.usage` (§3.3) through `runAgentBlock` → auto-seal → `writeSentinel`.
- **Multi-agent-block aggregation (plan-audit back-port):** when a pipeline runs more than one agent block, `models` is the dedup'd first-seen union; `costUsd`/`turns`/`durationMs` are summed across blocks that report them (absent values skipped, not zeroed); if no agent block reports usage, the sentinel carries no `usage` key.
- **Recorded decision (capture-only boundary):** `usage` is deliberately NOT forwarded into `ExecutionResult` the way `verify`/`outputs` are (`DispatchExecutor.readSentinel` / fixture `reconcile`) — D4's "checkable by a reader" means the sentinel in the evidence, not a new orchestrator surface. Both sentinel readers extract selective fields and ignore unknown keys, so this is additive-safe. Forwarding is unowned until a consumer pulls it.
- **Insertion order (frozen byte contract, audit):** `usage` lands **after `outputs`, before `blocks`** in the sentinel's conditional-assignment order (`output-sentinel.ts:211-218`). Goldens pin exact key arrays, so this position is fixed from day one.
- Doc note: `usage.durationMs` is the *third* duration in the evidence chain (`DispatchResult.durationMs`, `BlockOutcome.durationMs`, and this model-reported one) — the docs must carry the "model time, adapter-reported" disambiguation.

## 5. Evidence story after this PR

| Layer | Field | Answers |
|---|---|---|
| Manifest (sealed at fire) | `model.id` = requested string (level or id, `''` if unpinned) | "what was authorized" |
| Sentinel → evidence | `usage.models` = actual ids; `usage.costUsd`, `turns`, `durationMs` | "what actually ran, and what it cost" |

Authorized-vs-actual becomes *checkable by a reader* immediately; *enforced by verify* only when a consumer pulls that row (D4). Level→id compatibility semantics are deliberately undefined until then.

## 6. Testing (TDD throughout)

Platform note (audit): adapter `invoke()` tests are bash-stub-based and posix-gated per repo convention (`adapter.test.ts` `skipOnWindows`) — CI-only coverage. The level map and envelope parser MUST therefore be exported pure functions with platform-independent unit tests; only the spawn-wiring assertions live in the gated suites.

- **Level map (pure):** `fast`/`standard`/`max` → `haiku`/`sonnet`/`opus`; pass-through id; absent → undefined.
- **Adapter spawn args (gated):** `--model <id>` present/absent per `spec.model`; `--output-format json` always present.
- **Envelope parse (pure):** happy path extracts text + usage; malformed/non-JSON stdout falls back to raw-text + no usage; missing optional envelope fields tolerated (e.g. older CLIs lack `modelUsage`).
- **Behavior identity:** the agent text surfaced from the envelope's `result` is what the raw-stdout path surfaced, with the trailing-newline rule pinned explicitly (audit): raw `claude --print` stdout ends with `\n`; the envelope's `result` may not — the parser normalizes so `RuntimeExit.stdout` is identical in both modes, and the fixture asserts the exact bytes including the terminator.
- **Worker override (pure-ish):** `parsed.model ?? subagentDef.model` precedence where `BlockContext.subagent` is built; `AGORA_MODEL` stripped from runtime env (firewall regression).
- **Executor precedence matrix:** subagent.model alone / defaultModel alone / both (subagent wins) / neither (seals `''`, work carries no model); manifest `model.id` ≡ `work.model` in every case (the §3.4 invariant).
- **Client pass-through:** `dispatch({ model })` emits `AGORA_MODEL`; unset emits nothing; client performs no def-fallback (D6 regression).
- **Sentinel goldens:** existing goldens untouched (absence = zero diff); new golden with `usage` pins exact key array including its position (after `outputs`, before `blocks`) and round-trip stability.
- **Integration:** one in-proc run asserting requested-in-manifest + actual-in-sentinel end-to-end.

## 7. Documentation (same PR — no doc-less waves)

- `CHANGELOG.md`: entry for the wave.
- docs-site: `reference/agora-client-api.md` (subagent `model`, `DispatchWork.model`), `reference/dispatch-lifecycle.md` (requested-in-manifest / actual-in-sentinel, the `usage` block), `reference/cli.md` (`subagent register --model`). Level vocabulary documented once (client-api) and cross-linked.
- README: one line in the Offload section is NOT needed — this is reference-level, not positioning. Skip.

## 8. Ride-along

- Fix the stale run-1 comment in `examples/dogfood-selftest/src/index.ts` ("concurrency 2: the 4 items…" → run-2 wording).

## 9. Out of scope (named triggers)

| Deferred | Trigger |
|---|---|
| `imageDigest` pinning (pack-decision invariant #1) | Own PR; friction already felt on run 2 (sealed `:main` mutable tag) |
| verify `model` row (authorized-vs-actual enforcement + level compatibility semantics) | First consumer needing enforcement |
| Per-adapter level-map override config | Second runtime adapter |
| GHCR package visibility (anonymous pull of `agora-worker`) | Ops task, GitHub UI — not code |
| Manifest-vs-worker-blob model equality (stronger than the §3.4 invariant) | The deferred verify `model` row |

## 10. Audit changelog (2026-06-06, code-grounded audit)

1. D5 amended: worker→adapter rides the existing `RuntimeInvocation.model` typed seam, not adapter env — no §7.7 firewall exception; `AGORA_MODEL` is control-plane only.
2. §3.1 corrected: registration + stored blob already carry `model` (`subagent-register.ts:34,74`); no zod in agora-client; section reduced to tests + docs.
3. §3.2 corrected: CLI `--model` already exists (`cmd-subagent.ts:33`); docs only.
4. §3.3 gained the second contract change: `RuntimeExit.usage` (was unstated).
5. §4.3 pins the sentinel `usage` key position (goldens freeze byte order).
6. §3.4 names the pre-fire def-fetch restructure of `DispatchExecutor.fire`, the resolveModel replacement, and the resolve-race caveat with the actual invariant (manifest ≡ dispatched work).
7. D6 added: one resolution rule per layer; client def-fallback dropped (was dead code on the executor path and cost a conditional extra blob fetch).
8. §6 gained the trailing-newline byte-identity rule and the posix-gating / pure-function test split.
