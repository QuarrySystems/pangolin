# Model + cost identity in dispatch evidence — design

**Date:** 2026-06-06
**Status:** approved (brainstorm session, post dogfood run 2)
**Motivating run:** `dogfood-handoff-run2` (PR #51) — both workers ran `claude-opus-4-7[1m]` by image-default fall-through; the sealed manifests carry `model: { id: '' }`; cost/tokens were discarded. For a product whose pitch is "prove exactly what ran," the evidence could not answer "which model?" or "what did it cost?". Vault: `idea-model-cost-identity-in-the-dispatch`.

## 1. Decisions (locked)

| # | Decision | Choice |
|---|---|---|
| D1 | Pinning posture | **Pin-optional, capture-always.** Nothing fails for lack of a model anywhere in the chain. |
| D2 | Levels abstraction | **Reserved keywords now, no registry.** One opaque `model` string; `fast` / `standard` / `max` are reserved level names every adapter MUST map to its own models; any other value passes through verbatim as a provider-native id. |
| D3 | Default-model config | **`DispatchExecutor` option** (`defaultModel?: string`), so the orchestrator knows the requested model at fire time and seals it. |
| D4 | Verify scope | **Capture-only.** No new verify row. The authorized-vs-actual check is demand-pulled (same posture as the handoff row: evidence first, check when a consumer needs enforcement). |
| D5 | Threading seam | **First-class `model?: string` on `DispatchWork`** — model is part of "what was authorized," like `subagent`. It is NOT an env bundle (env rides as registered `EnvRef` bundles; a per-dispatch scalar doesn't fit that seam). It materializes as env (`AGORA_MODEL`) only at the worker→adapter boundary. |

## 2. The `model` string

One field, one grammar, interpreted by the runtime adapter:

- `fast` | `standard` | `max` — portable capability levels. The claude-code adapter maps them to the CLI's bare aliases: `haiku` / `sonnet` / `opus` (aliases resolve to current versions CLI-side; the mapping stays version-free).
- anything else — provider-native model id (e.g. `claude-opus-4-7`), passed to the runtime verbatim.

**Effective requested model** at fire time: `subagent.model ?? executor.defaultModel ?? unset`. Unset means the adapter passes no `--model` flag and the runtime's own default applies — exactly today's behavior.

A future second adapter (e.g. codex) brings its own three-line level map; plans and subagents written with levels stay portable. No mapping registry, no level-override config until a second adapter pulls them.

## 3. Requested side (orchestrator + client + CLI)

### 3.1 `agora-client` — subagent registration

- `subagent.register({ name, promptTemplate | systemPrompt, capabilities, model? })`: new optional `model: string` in the zod schema. Stored in the subagent definition blob (note: `DispatchExecutor.resolveModel` already reads `def.model` from the blob — the read path predates the write path; this closes it).
- `client.dispatch(work)`: `DispatchWork.model` (see 3.3). During resolve, if `work.model` is unset, default it from the resolved subagent definition's `model`. One rule, applied once, client-side — the worker/adapter never re-derives precedence.

### 3.2 `agora-cli`

- `agora subagent register --model <s>` flag, threaded to `subagent.register`.

### 3.3 `agora-core` — `DispatchWork`

- New optional field: `model?: string`. Documented grammar per §2. Non-secret; never redacted.

### 3.4 `agora-orchestrator` — `DispatchExecutor`

- New option `defaultModel?: string` alongside `workerImage`.
- At fire: effective requested model = subagent def's `model` ?? `defaultModel`; if set, placed on the `DispatchWork` it builds.
- `resolveModel` (manifest) becomes precedence-aware: same effective value seals into the existing manifest `model.id` (schema unchanged: `{ id, temperature, maxTokens }`; temperature/maxTokens stay 0 — claude-code exposes neither per-invocation). Unset still seals `id: ''` (today's best-effort zero).
- The manifest and the dispatched work therefore agree by construction — both derive from the same resolution.

## 4. Actual side (worker + adapter)

### 4.1 `agora-worker` — entrypoint env

- When the dispatch payload carries `model`, the worker adds `AGORA_MODEL=<value>` to the adapter's merged env (§5.8 merge — no implicit inheritance, so this is an explicit entry). Absent model → no entry.

### 4.2 `agora-runtime-claude-code` — adapter

- Reads `AGORA_MODEL`. Maps levels via a module constant `{ fast: 'haiku', standard: 'sonnet', max: 'opus' }`; any other value passes through. Result becomes `--model <id>` on the spawn arg list. No `AGORA_MODEL` → no flag (unchanged).
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

- The block flows into the dispatch evidence the same way `verify` and `outputs` already do. Golden byte-compat tests extend to pin both shapes (with/without `usage`).

## 5. Evidence story after this PR

| Layer | Field | Answers |
|---|---|---|
| Manifest (sealed at fire) | `model.id` = requested string (level or id, `''` if unpinned) | "what was authorized" |
| Sentinel → evidence | `usage.models` = actual ids; `usage.costUsd`, `turns`, `durationMs` | "what actually ran, and what it cost" |

Authorized-vs-actual becomes *checkable by a reader* immediately; *enforced by verify* only when a consumer pulls that row (D4). Level→id compatibility semantics are deliberately undefined until then.

## 6. Testing (TDD throughout)

- **Adapter spawn args:** level mapping (`fast`/`standard`/`max` → `haiku`/`sonnet`/`opus`), pass-through id, absent → no flag; `--output-format json` always present.
- **Adapter envelope parse:** happy path extracts text + usage; malformed/non-JSON stdout falls back to raw-text + no usage; missing optional envelope fields tolerated.
- **Behavior identity:** the agent text surfaced from `result` is byte-identical to what the raw-stdout path would have surfaced (fixture comparing both paths).
- **Executor precedence matrix:** subagent.model alone / defaultModel alone / both (subagent wins) / neither (seals `''`, dispatch carries no model).
- **Client default rule:** `dispatch({ model })` wins over subagent def; def fills when work.model unset.
- **Sentinel goldens:** existing goldens untouched (absence = zero diff); new golden with `usage` block pins bytes.
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
