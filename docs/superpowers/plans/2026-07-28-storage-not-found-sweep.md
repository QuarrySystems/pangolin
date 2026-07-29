---
title: storage-not-found repo-wide sweep report
task: task-sweep-verify
created: 2026-07-29
---

# Repo-wide `not found` / `ENOENT` / `NoSuchKey` sweep

## Methodology

Ran the mandated case-insensitive grep over all five trees (the four
`pnpm-workspace.yaml` roots plus `test/`, which sits outside every workspace
root):

```bash
rg -ni --type ts -e 'not found' -e 'ENOENT' -e 'NoSuchKey' \
   packages/ examples/ deploy/ docs-site/ test/
```

(`rg` was not on `PATH` in this environment; the equivalent ripgrep-backed
`Grep` tool was used instead, with `-i` case-insensitivity and the same
alternation, confirmed against the same three patterns.)

**Result: 104 hits across 56 files.** (Plan estimate was "~103 hits across
~55 files with -i" — the ±1 delta is expected drift since the estimate was
written before later commits on this branch touched line counts in a couple
of these files; not a discrepancy worth chasing.) `deploy/` produced zero
matches. Every hit is classified below with exactly one of the four verdicts.

## Verdict tally

| Verdict | Count | Meaning |
|---|---|---|
| (a) converted / already covered | 18 | feeds `storage.get` on a narrowed read path (`readOutputSentinel` or `readDispatchRecord`) |
| (b) not a caller | 70 | not a `StorageProvider` not-found signal at all |
| (c) deferred `dispatch.ts` catch | 7 | feeds only `markerPresent` / `readSubagentCapabilities` / the env-bundle read |
| (d) not narrowed | 9 | genuine `StorageProvider` not-found signal on a register/resolve/audit-read path this change does not touch |
| **Total** | **104** | |

All 18 verdict-(a) hits were already converted by an ancestor task
(`task-sentinel-read`, `task-retention-read`, `task-doubles-orchestrator`,
`task-doubles-cli`) before this sweep ran. **No gaps found** — see the Gaps
section.

## Renames (the "known item to fold in")

Two files carried stale titles/ids describing the deleted message-sniffing
mechanism even though their doubles already throw the typed
`StorageNotFoundError` (converted by `task-retention-read`). Both are fixed
in this task:

- `packages/pangolin-client/test/cancel.test.ts`:
  - `makeEnoentStorage()` → `makeNotFoundStorage()`; its `name: 'enoent'` →
    `name: 'not-found'` (:45-47).
  - Title at :109, `'is a no-op when the dispatch record is missing (ENOENT)'`
    → `'is a no-op when the storage backend throws StorageNotFoundError'`.
  - Title at :121, `'is a no-op when the dispatch record is missing
    (not-found message)'` → `'is a no-op when the dispatch record was never
    written (typed StorageNotFoundError)'`.
- `packages/pangolin-client/test/describe.test.ts`:
  - Title at :66, `'throws DispatchRecordExpiredError when the record is
    missing (ENOENT)'` → `'throws DispatchRecordExpiredError when the storage
    backend throws StorageNotFoundError'`; inline `name: 'enoent'` (:68) →
    `name: 'not-found'`.

After these edits, a fresh sweep of both files returns **zero** hits (the
renamed identifiers no longer contain "not found"/"ENOENT"), which is
expected and not a coverage loss — the underlying doubles were already typed.

**Noted but left alone (out of the explicitly-scoped known item):**
`packages/pangolin-client/test/retention.test.ts:180` also carries a stale
`name: 'enoent'` field on a double that already throws typed
`StorageNotFoundError` (added by `task-retention-read`'s new
"returns null when the storage backend throws StorageNotFoundError" test).
The reviewer's known-item note named only `cancel.test.ts` and
`describe.test.ts`; this one is cosmetic (doesn't affect any assertion) and
was left unchanged to keep this task's diff scoped to what was asked. Flagging
here so it's visible rather than silently swept up or silently missed.

## Gaps

**None.** Every verdict-(a) hit traces to a double an ancestor task already
converted (`task-sentinel-read` → `pangolin-product/test/sentinel-read.test.ts`;
`task-retention-read` → `pangolin-client/test/{retention,cancel,describe}.test.ts`;
`task-doubles-orchestrator` → `pangolin-orchestrator/test/{dispatch-sentinel-read,executors/dispatch,executors/dispatch-orchestrator.int}.test.ts`;
`task-doubles-cli` → `pangolin-cli/test/cmd-orch.test.ts`). No hit required a
new conversion beyond the two renames above.

## Full classification

### (a) — converted / already covered by an ancestor task

| file:line | note |
|---|---|
| `packages/pangolin-cli/test/cmd-orch.test.ts:577-578` | comment describing the double at :580, which already throws `StorageNotFoundError` (task-doubles-cli) |
| `packages/pangolin-client/test/retention.test.ts:180,219,226,236` | task-retention-read. :180 is a typed double (stale `name: 'enoent'` label noted above, not renamed — out of this task's named scope); :219-236 is the deliberately-inverted negative test (`endpoint not found (DNS)`) proving a generic `/not found/i` message now propagates instead of resolving to `null` |
| `packages/pangolin-client/test/cancel.test.ts:45,47,109,110` | task-retention-read converted the double to throw `StorageNotFoundError`; titles/`name` field were stale — **renamed in this task**, see Renames section |
| `packages/pangolin-client/test/describe.test.ts:66,68` | task-retention-read converted the double; title/`name` field were stale — **renamed in this task** |
| `packages/pangolin-product/test/sentinel-read.test.ts:38,41` | task-sentinel-read; deliberately-inverted negative test (`DNS lookup failed: host not found`) proving a generic message now propagates instead of resolving `{ status: 'absent' }` |
| `packages/pangolin-orchestrator/test/dispatch-sentinel-read.test.ts:85,288` | comments describing the double at :87, already converted (task-doubles-orchestrator) |
| `packages/pangolin-orchestrator/test/executors/dispatch-orchestrator.int.test.ts:60` | comment describing the already-converted double (task-doubles-orchestrator) |
| `packages/pangolin-orchestrator/test/executors/dispatch.test.ts:83` | comment describing the already-converted double (task-doubles-orchestrator) |

### (b) — not a `StorageProvider` not-found signal at all

| file:line | note |
|---|---|
| `test/e2e/inline-secret-lifecycle.test.ts:93` | `SecretStore`, not `StorageProvider` — keep |
| `packages/pangolin-cli/test/cmd-env.test.ts:281,300` | prose UI string printed by `env get` when `client.env.get()` (→`resolveLatest`) returns `null` — no throw involved — keep |
| `packages/pangolin-cli/test/cmd-pipeline.test.ts:90` | local `fs.readFile` of a CLI-supplied spec file path (`pipeline register <file>`), not `StorageProvider` — keep |
| `packages/pangolin-cli/test/integration.test.ts:287,292` | same prose-UI pattern as `cmd-env.test.ts` (`env get` prints `(not found)` on null) — keep |
| `packages/pangolin-cli/src/providers/stoa.ts:89,110` | local repo-file `readdir`/`readFile` for the Stoa sync provider (`.claude/skills/...`), not `StorageProvider` — keep |
| `packages/pangolin-cli/src/cmd-subagent.ts:112` | prose UI string (`subagent get`) — keep |
| `packages/pangolin-cli/src/cmd-env.ts:74` | prose UI string (`env get`) — keep |
| `packages/pangolin-cli/src/cmd-capabilities.ts:10,47` | comment + prose UI string (`capabilities get`) — keep |
| `examples/pattern-dogfood/src/index.ts:280,287` | prose validation-error strings appended to a local `errors[]` array (manifest-shape checks on an in-memory bundle) — keep |
| `examples/data-mapreduce/src/index.ts:427,465` | prose default-value/console strings unrelated to `storage.get` — keep |
| `packages/pangolin-core/test/storage-not-found.test.ts:8,17,19,38` | the `StorageNotFoundError`/`isStorageNotFound` unit test itself (task-core-error) — not a caller — keep |
| `packages/pangolin-worker/test/entrypoint.test.ts:417` | `SecretStore.resolve`, not `StorageProvider` — keep |
| `packages/pangolin-core/src/errors.ts:88` | `StorageNotFoundError`'s own default-message definition (task-core-error) — keep |
| `packages/pangolin-client/test/subagent-register.test.ts:149` | asserts on `subagent-register.ts:160`'s own error message, thrown after `resolveLatest` returns `null` — not a storage double — keep |
| `packages/pangolin-worker/test/adapter-loader.test.ts:27` | local adapter-dir `fs.access` loader rejection message — keep |
| `packages/pangolin-storage-local/test/smoke.test.ts:58,63` | provider-level test of `LocalStorageProvider.get()`'s own message (task-provider-local) — not a caller — keep |
| `packages/pangolin-runtime-claude-code/test/needs-input-helper.test.ts:62` | build-artifact-existence comment (`dist/assets/`) — keep |
| `packages/pangolin-runtime-claude-code/test/claude-spawn.test.ts:7` | `spawn()` binary-not-found comment — keep |
| `packages/pangolin-client/src/subagent-register.ts:160` | source of the message asserted in `subagent-register.test.ts:149` above — keep |
| `packages/pangolin-storage-local/test/not-found.test.ts:22,29` | provider-level test (task-provider-local's own test) — keep |
| `packages/pangolin-storage-local/test/integration.test.ts:318` | provider-level test — keep |
| `packages/pangolin-storage-local/src/index.ts:285,289,331,335` | provider's own `ENOENT`→`StorageNotFoundError` translation (task-provider-local) — this IS the fix behind the two narrowed paths, not a caller needing further conversion — keep |
| `packages/pangolin-storage-local/src/index.ts:156,200,436` | unrelated `ENOENT`→`null`/`[]` convention for `resolveByHash`/`listNames`/index-bootstrap — predates and is untouched by this change — keep |
| `packages/pangolin-worker/src/patch-capture.ts:55` | `git` binary `PATH`-resolution comment — keep |
| `packages/pangolin-client/src/dispatch.ts:559,585,642` | `dispatchWork`'s own user-facing errors thrown after `resolveLatest` returns `null` (already type-safe; no message-sniffing here) — keep |
| `packages/pangolin-worker/src/channel-loader.ts:152` | local channel-adapter-dir `fs.access` loader — keep |
| `packages/pangolin-worker/src/output-sentinel.ts:79` | local worker-workspace `readdir` (worker filesystem, not `StorageProvider`) — keep |
| `packages/pangolin-worker/src/adapter-loader.ts:36` | local adapter-dir `fs.access` loader — keep |
| `packages/pangolin-runtime-claude-code/src/claude-spawn.ts:9` | `spawn()` binary-not-found comment — keep |
| `packages/pangolin-storage-s3/src/index.ts:36,114,117` | provider-internal `isNotFound` detection (task-provider-s3) — same pattern as the plan's own worked example — keep |
| `packages/pangolin-orchestrator/src/mailbox/local-dir.ts:50,97,123` | `MailboxStore`, not `StorageProvider` — keep |
| `packages/pangolin-storage-s3/src/aws-s3-mailbox-client.ts:1,18` | `MailboxS3Client`, not `StorageProvider` — keep |
| `packages/pangolin-storage-s3/test/smoke.test.ts:102,106` | provider-level test fixture (`notFoundError()` helper for `S3StorageProvider`'s own tests) — keep |
| `packages/pangolin-storage-s3/test/not-found.test.ts:6,10,11,12,16,41,57,67` | provider-level test — task-provider-s3's own test file — keep |
| `packages/pangolin-storage-s3/test/encryption.test.ts:35,61,62,66` | provider-internal `_index.json` bootstrap fake (feeds `put()`'s registry read, not `StorageProvider.get()` reaching a narrowed reader) — keep |
| `packages/pangolin-orchestrator/test/view/build.test.ts:31` | `RunView` node-lookup test-helper error, unrelated to storage — keep |

### (c) — feeds only a deferred `dispatch.ts` bare catch

All are `pangolin-client`'s fire-path sibling suites (`fireWork`/`dispatchWork`/
`client.dispatch`), whose in-memory `get()` doubles feed `markerPresent`
(~:520-527), `readSubagentCapabilities` (~:681-684), or the env-bundle read
(~:743-751) — every one confirmed by reading the file's imports/describe
block, not inferred from the filename alone.

| file:line | note |
|---|---|
| `packages/pangolin-client/test/dispatch.test.ts:78` | `dispatchWork`/`fireWork` fire-path suite — keep |
| `packages/pangolin-client/test/dispatch-fire.test.ts:66` | "Mirrors the helper in dispatch.test.ts"; `fireWork` — keep |
| `packages/pangolin-client/test/dispatch-dedupe.test.ts:73` | `fireWork` dedupe-marker suite — keep |
| `packages/pangolin-client/test/dispatch-deadline.test.ts:94` | `client.dispatch()` deadline/timeout suite — keep |
| `packages/pangolin-client/test/dispatch-callback-bearer.test.ts:71` | `fireWork` callback-bearer suite — keep |
| `packages/pangolin-client/test/dispatch-pipeline.test.ts:63` | `fireWork` — `describe('dispatchWork — pipelineRef', …)` — keep |
| `packages/pangolin-client/test/dispatch-model.test.ts:57` | "mirrors dispatch-fire.test.ts"; `client.dispatch` model-passthrough suite — keep |

### (d) — genuine `StorageProvider` not-found signal on a path this change does not narrow

| file:line | note |
|---|---|
| `packages/pangolin-client/test/subagent-register.test.ts:42,222` | `registerSubagent` only calls `storage.resolveLatest`/`put`, never `storage.get` — the double's `get()` is a full-`StorageProvider`-shape stub, unexercised but still a genuine not-found signal on a register path — keep |
| `packages/pangolin-client/test/env-register.test.ts:48` | `registerEnv` register path — keep |
| `packages/pangolin-client/test/pipeline-register.test.ts:48,160` | `registerPipeline` register path — keep |
| `packages/pangolin-client/test/capabilities-register.test.ts:41` | `registerCapability` register path — keep |
| `examples/demo-claims-appeals/test/claims-appeals.test.ts:147` | feeds `OperationsApi.audit()` → `assembleBundle`'s bare `catch {}` (`packages/pangolin-orchestrator/src/audit/bundle.ts:41-47`) reading an audit `manifestRef` — a fail-open read path this change does not narrow (distinct from, but structurally identical to, `dispatch.ts`'s three deferred catches) — keep |
| `examples/offload-fanout/test/fanout.test.ts:193` | same `assembleBundle` bare-catch pattern — keep |
| `examples/handoff-dag/test/handoff.test.ts:216` | same `assembleBundle` bare-catch pattern — keep |

## Gate verification

- **`pnpm -r build`**: green across all packages/examples, including
  `docs-site` and every `tsc --noEmit` example check.
- **`pnpm -r test`**: green — 28/28 packages with a `test` script passed on a
  clean run (all "Test Files … passed", zero failures). One transient failure
  was observed on an earlier run in
  `packages/pangolin-orchestrator/test/serve-driver.test.ts` ("error
  resilience: a throwing transport.publish does not crash serve and onError is
  invoked", `expected 0 to be greater than 0`) under full-monorepo parallel
  load. This test's own git history (`b7f5760`, "widen serve-driver/
  pressure-runner poll budgets (fix wall-clock flake class)") documents it as
  a pre-existing wall-clock flake class; it is not in this sweep's file list,
  does not touch `StorageProvider`, and passed cleanly both standalone
  (twice) and on a subsequent full `pnpm -r test` run. Not attributable to
  this task or any ancestor task in this plan.
- **`pnpm test:e2e`**: green — 20/21 test files fully passed, 1 file
  (`test/e2e/tamper-evident-minio.test.ts`) skipped in its entirety (gated on
  `PANGOLIN_S3_ENDPOINT`, i.e. a running MinIO instance — self-skips per its
  own `process.env.PANGOLIN_S3_ENDPOINT ? describe : describe.skip`). 77
  tests passed, 3 skipped total: the MinIO file above (1) plus one gated test
  each in `test/e2e/fargate-cloud-path.test.ts` (`PANGOLIN_E2E_AWS_ENABLED`)
  and `test/e2e/manifest-deploy.test.ts` (a documented, permanent
  `it.skip` — not an env gate). `test/monorepo-bootstrap.test.ts` (14 tests)
  passed as part of this run, confirming the `test/` tree — otherwise
  invisible to `pnpm -r test` — was actually executed.
- **`typecheck:test`**: green for all six named packages —
  `pangolin-product`, `pangolin-providers-aws-creds`, `pangolin-secret-store`,
  `pangolin-signer-aws-kms`, `pangolin-storage-local`, `pangolin-storage-s3`.
- `packages/pangolin-client`'s `test/cancel.test.ts` and `test/describe.test.ts`
  (the two files edited by this task) were additionally checked with
  `eslint test/cancel.test.ts test/describe.test.ts test/retention.test.ts
  --ext .ts` — clean, no errors.

## Files touched by this task

- `docs/superpowers/plans/2026-07-28-storage-not-found-sweep.md` (this report)
- `packages/pangolin-client/test/cancel.test.ts` (renamed stale
  ENOENT/not-found titles and provider-id field — see Renames)
- `packages/pangolin-client/test/describe.test.ts` (same)

No other file required conversion; every hit not already covered by an
ancestor task classified as (b), (c), or (d) — see tables above.
