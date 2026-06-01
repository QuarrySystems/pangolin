# offload-fanout — §7 acceptance example

Demonstrates safe parallel fan-out dispatch with a tamper-detecting audit bundle.

## What this example shows

- **Safe fan-out**: three independent `code-edit` items fire concurrently (concurrency 2). Each holds a per-file `resourceLock` so two items never race on the same file. `fixture/shared.ts` has its own lock; if two items targeted it they would serialize automatically.
- **Patch escape**: each dispatched worker produces an escaped result artifact (content-addressed storage ref) that the orchestrator surfaces as `resultRef` — the patch never lives in the run state database.
- **Tamper-detecting audit bundle**: after all items are terminal the orchestrator seals the epoch (Merkle hash chain + `LocalAnchor`), publishes the audit export, and `OperationsApi.audit(runId)` assembles a verifiable `AuditBundle`. The `report.claim` is `'tamper-detecting'` and `report.intact` is `true` on a clean run.

The guarantee tier is **tamper-detecting** (LocalAnchor stores the root in the SQLite DB). For a stronger guarantee swap `LocalAnchor` for `S3ObjectLockAnchor` — `report.guarantee` will read `'external-immutable'`. Never describe LocalAnchor as "tamper-evident" or "compliant".

## Live demo (requires Docker + Anthropic API key)

```sh
# From repo root — reads ../../.env for ANTHROPIC_API_KEY
pnpm --filter offload-fanout-example start:env
```

Or set the key in your shell and run:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
pnpm --filter offload-fanout-example start
```

The demo:
1. Submits `plan.json` (3 parallel edits + 1 verify) to a local MailboxSubmissionTransport.
2. The `serve` driver ticks the AgoraOrchestrator until all items are terminal.
3. Prints each item's `resultRef` (escaped artifact URI).
4. Assembles and prints the audit bundle (`intact`, `claim`, `anchorId`, `guarantee`).
5. Exits non-zero if any item failed or `report.intact === false`.

### CLI flow (when `agora` CLI is available)

```sh
agora orch serve &
agora orch submit plan.json
agora orch watch <runId>
agora orch audit <runId>
```

## CI smoke test (no Docker / no API key)

```sh
pnpm --filter offload-fanout-example test
```

Runs `test/fanout.test.ts` with vitest. Uses a fake executor (no containers, no LLM). Verifies:
- `plan.json` has the correct fan-out shape (3 per-file-locked edits + verify depends_on all 3).
- A real `AgoraOrchestrator` with the fake executor drives the plan to completion.
- Every item reaches `done`; each edit has a `resultRef`.
- `bundle.report.intact === true` and `bundle.report.claim === 'tamper-detecting'`.

## Fixture files

`fixture/{alpha,beta,shared}.ts` each export `OLD_NAME`. The real-Docker `code-edit` subagent is prompted to rename `OLD_NAME → NEW_NAME`. The `verify` subagent checks the rename succeeded.
