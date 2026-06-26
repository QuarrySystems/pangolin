# langgraph-changeorder — a LangGraph agent + a thin Pangolin provenance seam

An ordinary [LangGraph.js](https://github.com/langchain-ai/langgraphjs) agent
processes a single construction **change order** and pauses for a human
approve/reject. It runs perfectly well on its own. A **thin Pangolin seam** wraps
that same agent — unchanged — and turns the run into a **tamper-evident audit
bundle**, including a **cryptographically sealed human approval**, that a third
party re-verifies with nothing but `@quarry-systems/pangolin-verify`.

> **The thesis:** Pangolin is *additive*. You keep your orchestrator (LangGraph),
> add one seam, and gain verifiable provenance you could not produce before. The
> agent does not know Pangolin exists.

Everything here runs **offline and $0** — the agent's nodes are deterministic (no
LLM, no API key, no network), so the proof runs in CI.

---

## What's in the box

| File | Role | Pangolin-aware? |
|---|---|---|
| `src/agent.ts` | The LangGraph agent (`ingest → assess → approvalGate → finalize`). Stock `interrupt()` for the human pause. | **No** — zero Pangolin imports |
| `src/run-plain.ts` | Drives the agent **alone**. The "before" picture. | No |
| `src/seam.ts` | **The seam.** `withProvenance()` drives the *same* agent and seals every node + the approval into a Pangolin `AuditBundle`. | Yes — this is the integration |
| `src/run-sealed.ts` | Drives the agent **with the seam** and writes the bundle. The "after" picture. | Imports the seam |
| `src/verify.ts` | **Standalone auditor.** Re-verifies a bundle from the 3 JSON files. Imports only `pangolin-verify` + `pangolin-core` hashing — never the agent/orchestrator. | Verifier only |
| `src/tamper.ts` | Runnable proof: seals, verifies, then mutates one field two ways and shows rejection. | Verifier only |
| `test/proof.test.ts` | The 5 acceptance criteria under vitest. | — |

---

## Run it

```bash
pnpm --filter langgraph-changeorder-example install   # from repo root, once

pnpm --filter langgraph-changeorder-example agent     # 1. agent ALONE (no Pangolin)
pnpm --filter langgraph-changeorder-example sealed    # 2. agent + seam → writes ./out/*.json
pnpm --filter langgraph-changeorder-example verify    # 3. standalone verifier re-checks ./out
pnpm --filter langgraph-changeorder-example tamper    # 4. tamper demo: clean ✓, tampered ✗
pnpm --filter langgraph-changeorder-example test      # all 5 acceptance criteria
```

`verify` prints the real `pangolin-verify` report:

```
  pangolin-verify  ·  CO-2026-0417                  ✓ TAMPER-DETECTING
  ──────────────────────────────────────────────────────────
  ✓ chain        10 entries, hash-linked, no gaps
  ✓ root         merkle = anchored root
  ✓ signature    true
  ✓ anchor       offline  (detect)
  ✓ handoff      1 input ref accounted for      ← finalize consumes the sealed approval
  ✓ manifest     manifests bound to the chain
  ──────────────────────────────────────────────────────────
approval seal: OK — approval sealed and consumed (pangolin://changeorder/approval/a/sha256:cf93…)
  approve by human:dana.okafor (Project Director) at 2026-06-25T16:40:00.000Z
overall: VERIFIED ✓
```

---

## The seam diff — exactly how few lines

**The agent is unchanged: 0 lines touched.** `agent.ts` is imported and run
verbatim by both `run-plain.ts` and `run-sealed.ts`.

**At the call site, the seam is a one-line swap:**

```diff
- // run-plain.ts — agent alone
- const outcome = await runPlain(changeOrder, decide);

+ // run-sealed.ts — agent + Pangolin
+ const { outcome, bundle, approvalRecord } = await withProvenance(changeOrder, decide);
+ //   ...then write bundle / context / approval to disk
```

**The whole seam is one new file**, `seam.ts`. Its `withProvenance()` function is
124 LOC, of which **~33 lines are the actual Pangolin audit calls** — the rest is
the *same* `graph.stream(...)` / interrupt / resume loop that `run-plain.ts`
already runs. Those 33 lines are the entire surface area:

```ts
// build + chain a manifest per node (real SHA-256 self-hash)
const { manifest, bytes } = buildManifest({ runId, itemId, executor, executorManifest, secretRefs: [], actor, firedAt, inputRefs });
log.append({ runId, kind: 'item.fired', itemId, manifestRef, actor, at: firedAt });
log.append({ runId, kind: 'item.reconciled', itemId, status: 'done', at, resultRef, outputRefs });

// seal the human approval as a content-addressed, hash-chained record
const approvalBytes = new TextEncoder().encode(canonicalJsonString(approvalRecord));
const approvalRef = `pangolin://${ns}/approval/a/${computeContentHash(approvalBytes)}`;

// seal the epoch: Merkle root over the chain, signed + anchored
await log.sealEpoch(runId);
const bundle = await assembleBundle({ runId, entries, root, items }, { anchor, storage });
```

---

## Why the sealed approval is more than a `interrupt()`

A plain LangGraph `interrupt()` (in `agent.ts`) **pauses and resumes** — it
records nothing. At that *same* pause, the seam:

1. Builds a real `ApprovalRecord` (`approver`, `decision`, `decidedAt`,
   `subjectItemId`) — the exact shape Pangolin's `HumanApprovalExecutor` seals.
2. Content-addresses it: `pangolin://changeorder/approval/a/sha256:<hex>` over the
   canonical-JSON bytes (real SHA-256).
3. Binds it **into the hash chain** via the approval node's
   `item.reconciled.outputRefs.approval`.
4. Makes `finalize` **consume** it via `inputRefs.approval`, so provenance closure
   ties the outcome to the decision.

That last step makes the approval **non-optional**. Strip it, detach it, or change
who approved, and verification fails two independent ways:

- **Edit the approval record** → it no longer hashes to the ref sealed in the
  chain → `approval seal: FAILED` (see `tamper.ts`, tamper 2).
- **Edit the chained ref** → the Merkle root no longer matches the anchored root
  → `verifyBundle` rejects with `root-mismatch`.
- **Drop the `finalize` consumption** → handoff closure fails.

## Tamper test (acceptance criterion 4)

`pnpm … tamper` (and `test/proof.test.ts`) mutate **one field** post-hoc:

```
baseline            : VERIFIED ✓ (intact=true, approval=true)
tamper: chain field : REJECTED ✗ (intact=false, failure=chain)      ← rewrote one entry's timestamp
tamper: approval seal: REJECTED ✗ (approval=false) — does not hash to the sealed ref
```

---

## The real Pangolin API this builds against

No invented surface — every call is a real export, mirroring `examples/verify-tsa`:

| Capability | Real API (package) |
|---|---|
| Hash chain + Merkle seal | `AuditLog.append` / `.sealEpoch` (`pangolin-orchestrator`) |
| Per-node manifest + self-hash | `buildManifest` (`pangolin-orchestrator`) |
| Content addressing (SHA-256) | `computeContentHash`, `canonicalJsonString` (`pangolin-core`) |
| Signer / anchor / store | `createLocalSigner`, `LocalAnchor`, `SqliteRunStateStore` |
| Bundle assembly | `assembleBundle` (`pangolin-orchestrator`) |
| Standalone verification | `loadBundle`, `buildAnchor`, `verifyBundle` (`pangolin-verify`) |

The SHA-256 is genuine: `chainHash(canonEntry(e), prevHash) = sha256(canonStr +
prevHash)` and Merkle roots with `0x00`/`0x01` domain separators, all in
`pangolin-core/src/audit-merkle.ts`.

## Honest bounds & what's stubbed

- **`tamper-detecting`, not `tamper-evident`.** This demo uses `LocalAnchor`
  (guarantee `detect`), so the verifier's claim is `tamper-detecting` — it
  *detects* any mutation (which is the acceptance bar). Swapping in
  `S3ObjectLockAnchor` (WORM) promotes the same bundle to `tamper-evident`; no
  other change.
- **The approval sealing is replicated, not driven by Pangolin's run-engine.**
  Because the thesis is "keep *your* orchestrator," the seam does **not** hand
  control to Pangolin's `submitRun` engine — that would replace LangGraph.
  Instead it reproduces `HumanApprovalExecutor.reconcile()`'s sealing path
  (same `ApprovalRecord` shape, same `canonicalJsonString → computeContentHash →
  pangolin://…/approval/a/<sha256>`, same `outputRefs.approval` binding), so the
  bundle is byte-compatible with that executor and the standard verifier's
  handoff/manifest checks bind it unmodified. Flagged in `seam.ts` with a
  `TODO(pangolin)`.
- **No Pangolin core was modified** to make this work.

## Acceptance criteria

- [x] The LangGraph agent runs standalone with the seam removed — `pnpm … agent`, test 1.
- [x] Running with the seam produces a bundle verified by the standalone verifier using real SHA-256 — tests 2.
- [x] The human approval is sealed into the bundle and the verifier checks it — test 3.
- [x] The tamper test demonstrably fails verification — `pnpm … tamper`, tests 4a/4b.
- [x] The seam diff is small: **agent 0 lines, call-site 1 line, ~33 audit-API lines** in one wrapper file.
- [x] One orchestrator (LangGraph), no abstraction layer, no UI, one change order end to end.
