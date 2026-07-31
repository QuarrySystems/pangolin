# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
All packages are versioned in lockstep; this file is the changelog for the whole
workspace. See [RELEASING.md](./RELEASING.md) for how a release is cut.

## [Unreleased]

### Breaking

- **`CliContext` requires a third member, `getSyncProviders`.** This affects only
  code that imports `buildProgram` to embed the CLI inside another program — if you
  invoke the `pangolin` binary, nothing changes. Migration is one line: add
  `getSyncProviders: defaultGetSyncProviders` (exported from
  `@quarry-systems/pangolin-cli`) to the context you already construct. The member's
  type is `() => Promise<{ providers: unknown; source: string } | null>`.

### Added

- **Sync providers can now live outside this repo.** `pangolin subagent sync` and
  `pangolin capabilities sync` previously understood exactly two on-disk layouts:
  Claude Code's `.claude/agents` and stoa's convention. Any other layout meant
  forking the CLI or abandoning it for `pangolin-client` directly — the authoring
  guide's advice was to "add an entry to the `PROVIDERS` map", which is only
  actionable if you *are* pangolin. You can now implement `SyncProvider` yourself
  and register it from your config:

  ```javascript
  // pangolin.config.mjs
  import { MyProvider } from 'my-pangolin-provider';
  export const syncProviders = [new MyProvider()];
  ```

  A provider can compose with the built-in ones and override only the half that
  differs, so a typical one is a few dozen lines. This also unblocks conventions
  whose prompts are Mustache templates: a provider may emit `promptTemplate`, which
  is rendered so `{{placeholders}}` are substituted, where the built-in
  `claude-code` provider always emits `systemPrompt`, which is passed to the model
  verbatim.

  Three things to know before writing one:

  - Your provider package is imported by `pangolin.config`, and that file is
    evaluated by the **`pangolin-mcp` server at startup** — a process that has
    nothing to do with syncing. So the package must be a real `dependency` (not a
    `devDependency`), must survive a pruned production install, and must not throw
    at module scope. A provider that violates this takes the MCP server down.
  - The config is loaded **lazily**, only when `--provider` names something the
    built-ins do not cover, so a broken config will not break
    `--provider claude-code`. But a *typo'd* provider name is a built-in miss, so it
    does load the config — and you will see the config's error rather than
    `unknown --provider`.
  - Built-in names (`claude-code`, `stoa`) cannot be overridden. A collision is a
    hard error naming the config file and the offending array index.

  Full guide: [Sync capabilities & subagents](https://quarrysystems.github.io/pangolin/how-to/sync-capabilities-subagents/).

- **`@quarry-systems/pangolin-cli/providers` subpath export**, publishing what a
  provider author needs: the `SyncProvider`, `SubagentDef`, and `CapabilityBundle`
  types, plus `ClaudeCodeProvider` and `StoaProvider` to compose with, and
  `splitFrontmatter` for layouts that use YAML frontmatter. **Provisional** — this
  surface may change on a minor release. `loadSubagents(dir)` in particular means
  "the directory holding subagent files" to one built-in provider and "a repo root"
  to the other; that is unresolved, and resolving it may change the signature.

- **`SubmissionTransport.readLatestOutbox(runId, kind?)` — an optional fast path**
  for "the newest record of this kind", which is all any client-facing read
  actually wants. Optional on the interface, so third-party transports keep
  working untouched; callers fall back to `readOutbox` when it is absent.
  `MailboxSubmissionTransport` implements it by scanning keys in reverse, which is
  sound because its outbox keys are zero-padded to a fixed width, so lexical key
  order is publication order.

### Added

- **`FargateProvider` can give each dispatch its own AWS identity.** New optional
  `taskRoleArn` on `FargateProviderOpts`, passed through to ECS
  `overrides.taskRoleArn`. Previously every dispatch on a target ran with whatever
  role the task definition was registered with, so a low-trust dispatch and a
  high-trust one held the same credential and per-dispatch S3 / secret scoping was
  impossible. ECS has always accepted this override; the provider never set it.

  Pass a string for a fixed role, or a resolver `(spec) => string | undefined` to
  vary it per dispatch — `TaskSpec` carries `dispatchId`, the natural key for a
  per-dispatch role. Callers that set nothing keep today's behaviour exactly: the
  field is omitted from the override entirely, not sent as `undefined`.

  Deliberately not on `TaskSpec`: that contract is provider-agnostic and shared with
  the local Docker provider, and an IAM ARN is an AWS concept. The task *execution*
  role stays on the task definition — ECS does permit overriding it, but it pulls
  images and writes logs, so varying it per dispatch breaks launch rather than
  scoping anything.

- **The staged-secret naming contract is now declared and exported.**
  `dispatchSecretName`, `callbackHmacSecretName`, `CALLBACK_HMAC_NAME_PREFIX` and
  `dispatchSecretPolicyPatterns` from `@quarry-systems/pangolin-client`. `fireWork`
  stages per-dispatch secrets as `<dispatchId>/<envName>` and the callback HMAC key
  as `pangolin/callback-hmac/<dispatchId>`; both were correct and stable but
  undeclared, so a caller writing a least-privilege IAM policy had to hardcode a
  shape it had no promise about. The dispatch path now builds those names through
  the same helpers, and a test pins that, so the published contract cannot drift
  from what is actually staged.

  `dispatchSecretPolicyPatterns(dispatchId)` returns the two Secrets Manager
  resource patterns covering exactly one dispatch — two rather than one because the
  inline secrets and the callback key do not share a prefix. Combined with a
  per-dispatch `taskRoleArn`, that is the boundary that stops one run reading
  another run's callback key.

### Fixed

- **`PANGOLIN_CLAUDE_PERMISSION_MODE=strict` was silently ignored — a safety
  control failing open.** The worker's runtime env firewall is default-deny and
  `PANGOLIN_*` is not on its allow-list, but the Claude Code adapter reads permission
  mode out of the *post-filter* `ctx.env`. So the variable was withheld from the one
  component that consumes it: `resolveBypassFlag` saw nothing, fell back to `bypass`,
  and passed `--dangerously-skip-permissions` for a dispatch the operator had asked
  to run with the tool-call gate on. No error, no warning, and no observable
  difference from having configured nothing.

  A short, explicitly-named set of non-credential **adapter config** vars now passes
  the firewall: `PANGOLIN_CLAUDE_PERMISSION_MODE` and
  `PANGOLIN_DISABLE_NEEDS_INPUT_HELPER`. By exact name, **never by a `PANGOLIN_`
  prefix rule** — that would hand `PANGOLIN_CALLBACK_TOKEN_REF` to a prompt-injected
  sub-agent and re-open the whole firewall; a test pins that. The blanket "drops all
  `PANGOLIN_*`" assertion was replaced with a credential-by-credential one covering
  more variables than before, so narrowing the claim did not narrow the protection.

  **If you rely on `strict`:** verify rather than assume. On a worker image predating
  this change the mode was ignored, so a dispatch you believed was gated was not.
  Naming the variable in `PANGOLIN_RUNTIME_ENV_ALLOW` forces it through any version
  of the filter.

- **Patch capture no longer executes commands from a repo-local `.git/config`.**
  `buildGitEnv` set `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, which
  kill `~/.gitconfig` and `/etc/gitconfig` — but neither touches the workspace's own
  `.git/config`, and capture runs against a tree the agent controls. Directives such
  as `core.fsmonitor` and `diff.<driver>.textconv` execute arbitrary commands from
  there.

  The capture invocations now pass `-c core.fsmonitor=false -c core.pager=cat
  -c core.hooksPath=/dev/null`, and the diff adds `--no-ext-diff --no-textconv`
  (flags rather than `-c`, because external-diff and textconv drivers are per-driver
  and declared through the repo's own `.gitattributes`).

  The credential lane was already closed — `buildGitEnv` is a genuine allowlist, so
  a hook ran with no `AWS_*` or `PANGOLIN_*` in its environment. What this closes is
  code execution as the worker from repository content, which matters for any
  consumer capturing patches against a repo it does not control.

  **Still partial:** `filter.<driver>.clean` executes on `git add` when the repo's
  `.gitattributes` declares it, and like textconv it is per-driver with no single
  switch. The general answer — relocating `GIT_DIR` outside the workspace — is
  recorded rather than half-done.

- **`timeoutSeconds` is now enforced worker-side; before, it bounded nothing.**
  `pangolin-client` emitted `PANGOLIN_AGENT_TIMEOUT_SECONDS` and
  `PANGOLIN_PLUGIN_INSTALL_TIMEOUT_SECONDS` into the task environment and *nothing
  read them* — `envSecondsOr`, which the emit-site comment named as the reader's
  safety net, did not exist. `boundedAwaitExit` does bound, but only on the
  `awaitExit` path, which a fire-and-forget consumer never calls. For those
  consumers there was no bound anywhere in the stack, and on Fargate a hung agent
  bills until someone notices.

  The agent phase and each plugin install are now bounded, with SIGTERM followed by
  SIGKILL after a grace period. A timed-out agent resolves with exit code 124 and a
  reason on stderr (so it reports as a *failed* dispatch, keeping whatever output
  it produced) rather than a container that never exits; a timed-out plugin install
  throws naming the plugin, matching the existing fail-fast contract.

  **The bounds travel on `RuntimeContext`, not in the runtime env** — new optional
  `agentTimeoutSeconds` / `pluginInstallTimeoutSeconds`. Reading them from the
  adapter's `ctx.env` (the obvious implementation, and the one originally proposed)
  cannot work: the worker's `filterRuntimeEnv` is default-deny and strips every
  `PANGOLIN_*` variable before the adapter sees it, so such a bound would silently
  never apply. `parseWorkerEnv` reads them from the worker's own process env
  instead — the same route `PANGOLIN_SETUP_TIMEOUT_SECONDS` already takes.

  **Behaviour change:** every dispatch is now bounded. Defaults are 7200s for the
  agent phase and 300s per plugin install, mirroring what the client already
  derives, and they apply even when neither variable is set — an unset bound means
  the default, never "unbounded". A plugin install that legitimately exceeds 5
  minutes will now fail where it previously hung; raise `timeoutSeconds` or set
  `PANGOLIN_PLUGIN_INSTALL_TIMEOUT_SECONDS` on the worker if so.

  Note this bounds the *agent phase*, not the whole task: bundle fetch, capture and
  callback sit outside it, so a consumer on Fargate still wants its own task-level
  bound.

- **`dedupeOnDispatchId` could silently stop guarding.** The dedupe marker probe in
  `fireWork` treated *any* `storage.get` failure as "the marker is absent, proceed" —
  so an authorization denial, a network fault or a throttle read as "not yet fired"
  and let a duplicate dispatch through. The consequence is the one step 0 exists to
  prevent: two containers for a single `dispatchId`, both writing
  `dispatches/<id>/output.json`, with the second's callback HMAC key replacing the
  first's mid-run. No error, no warning, and `dedupeOnDispatchId: true` still
  appeared to be in force.

  Only `StorageNotFoundError` now means absent; every other error is rethrown, so a
  mis-scoped storage policy fails loudly at the first dispatch instead of quietly
  removing the guarantee. The check is type-based (`isStorageNotFound`), never a
  message sniff — matching what `readDispatchRecord` already did for the same
  `dispatches/<id>/` prefix.

  **Behaviour change:** a `StorageProvider` that signals absence with a bare `Error`
  instead of `StorageNotFoundError` will now make the *first* fire throw rather than
  silently proceed. The contract has always required `StorageNotFoundError`
  (`StorageProvider.get`, "never return a sentinel value"); both in-tree providers
  honour it. This only affects third-party providers that do not.

- **`serve()` no longer leaves a multi-queue config half-inert.** It drove exactly
  one queue (`opts.queue ?? 'default'`) while `PangolinOrchestrator` accepted and
  validated the full queue map, so an item submitted to a configured, *validated*
  queue that the loop did not happen to tick sat at `ready` forever — with no error
  in the serve log, in `orch status`, or in the audit chain, while the loop
  dispatched other work normally. Observed at 20+ minutes; the same run resubmitted
  unchanged to the ticked queue finished in 67 seconds.

  *An earlier version of this entry added that "`orch cancel` could not rescue it
  either, because cancellation is processed by that same tick loop." That was wrong
  and the live stack disproves it: `cancelRun` is not queue-scoped — it walks
  `store.getItems(runId)` and flips `pending`/`ready` to `cancelled` without
  consulting a queue, and the serve loop drains control envelopes in its body before
  calling `tick`. Cancel has always worked on a stranded run provided serve was up.
  The one real gap was narrower and is fixed below: a cancel queued while serve was
  **down** lost the race to the reconcile-first tick.*

  Naming a `queue` explicitly still drives exactly that queue, so one-process-per-queue
  deployments are unaffected. **Omitting it now drives every configured queue**
  rather than defaulting to `default`. Either way, queues that this process does not
  drive are named in a startup warning — scoping to one queue is legitimate, so it
  is a notice, not a refusal.

  **Behaviour change:** a deployment that configures extra queues and passes no
  `queue` will now drive them. That is the fix, but it changes what a running
  process does; pass `queue` explicitly to keep it single-queue. New
  `PangolinOrchestrator.getConfiguredQueues()` exposes the names.

  Queues are ticked sequentially and **independently**: a failure in one is
  collected and the rest are still attempted, so a single broken queue cannot
  starve its siblings. A lone failure is rethrown as-is (single-queue deployments
  see identical error surfacing); several become an `AggregateError`. The pass
  still fails overall, so a broken tick does not read as a healthy iteration.

  **A queued cancel is now honoured before the first dispatch.** The serve loop
  drains the transport before its tick, so a cancel beats the dispatch it targets —
  but the reconcile-first tick that runs once before the loop did not, so a cancel
  queued while the process was down lost the race to the very item it was meant to
  stop. Ingress (submissions → extends → control) now drains once before that tick
  too, as a single ordered unit. This matters most on the first start after
  upgrading, when work stranded on a previously-undriven queue becomes dispatchable
  and cancelling it is the only remedy.

  A failure in the **reconcile-first** tick no longer rejects out of `serve()`; it
  is reported and the loop starts anyway, leaving `/readyz` at 503 `not-ready`
  until a tick succeeds while `/healthz` stays up. Previously one broken queue
  prevented every healthy queue from ever being driven, and a deterministic fault
  crash-looped the process under a restart policy while serving nothing.

- **A long-lived `serve` stack no longer makes every client read slower.** Reading
  one completed run from a stack that had been up a while took over a minute, and
  the cost tracked how long the stack had been running rather than anything about
  the run. Two faults compounded.

  Writes were amplified: the serve loop asked for *all* run status each tick and
  published one outbox record per run per tick — forever, including for runs that
  had reached a terminal state days earlier. Nothing is ever deleted, so a
  67-second run was measured holding 23,307 outbox records. The loop now publishes
  a run's final all-terminal status once and then stays quiet about it, so storage
  grows with work done instead of with uptime.

  Reads were unindexed: `status()`, `audit()` and `watch()` each want a single
  record, but fetched and decoded every record ever published for the run to find
  it. They now use `readLatestOutbox` where the transport offers it.

  Together these fix a polling API that got more expensive the longer it waited —
  `watch()`'s per-poll cost rose with uptime, so a long run degraded while running,
  and an unattended driver polling runs to terminality could spend longer on one
  sweep than its own poll interval.

  Two notes on scope. The fixes are ordered: the audit export is published once and
  status records used to keep landing on top of it, so the reverse scan only reaches
  it cheaply *because* terminal runs went quiet. And existing outboxes are not
  rewritten — the accumulated records stay, but reads no longer walk them.

- **`pangolin orch runs` — list every run the outbox knows about.** There was no way
  to ask this from a client at all: every other read takes a `runId` you must already
  hold, so discovering what exists meant opening the serve container's SQLite by hand.
  Backed by new optional `MailboxStore.listPrefixes` / `MailboxS3Client.listPrefixes`
  (S3 `Delimiter` + `CommonPrefixes`) and `SubmissionTransport.listRuns`, plus
  `OperationsApi.listRuns()`. Costs one entry per **run** rather than one per
  **record** — measured at 2 s against ~8 min on a stack holding 1.7M objects for 95
  runs. All three members are optional, so existing implementations stay valid;
  `listRuns` falls back to deriving run ids from `list` when the mailbox has no
  delimited support, and `S3Mailbox` advertises `listPrefixes` only when its seam can
  really do it rather than emulating it at the cost it exists to avoid.

- **The serve loop publishes a run's status only when it has changed.** Suppressing
  republication of *terminal* runs bounded growth for runs that finish, and did
  nothing for runs that do not: a run with a single permanently-stuck item never
  satisfies "all items terminal", so it re-emitted identical bytes every tick
  indefinitely. Those are the runs most likely to sit for days, so they were the worst
  ones to leave out. Status is now fingerprinted and republished only on a real change
  — which covers stuck runs, and cuts writes for slow runs generally. Every distinct
  change is still published, including changes to `blockedBy`, `resultRef`,
  `manifestRef` and `verify` that leave the status strings untouched.

- **Outbox records are no longer overwritten when `serve` restarts.**
  `MailboxSubmissionTransport` numbered outbox keys from a per-instance counter seeded
  at 0, and mailbox writes are overwrites — so every restart rewound the counter and
  the new process re-minted keys the previous one had already used. Two silent
  failures followed: records written before the restart were **clobbered**, eventually
  including a run's `kind: 'audit'` record (after which `orch audit` reports "no audit
  export published yet" for a run that definitely sealed one); and the
  lexically-greatest key stopped being the newest, so `status()` — which resolves the
  latest record by key order — could return a **pre-restart** record and appear to go
  backwards in time.

  The sequence is now seeded from wall-clock ms and never allowed to decrease, and
  keys carry a per-instance discriminator so two processes starting in the same
  millisecond cannot collide. Keys widen from 12 to 16 digits; legacy 12-digit keys
  sort *before* the new ones, so an upgraded stack keeps reading its newest record.

  Honest limit: if two processes start within the same millisecond *and* the earlier
  one has already drifted ahead of the clock, their relative order is a tie. Nothing
  is lost in that window — only the ordering between genuinely concurrent records is
  unspecified.

- **The report embedded in an audit bundle is now the complete verdict.**
  `assembleBundle` built `bundle.report` with the chain-only `verify()` — chain, root,
  signature and anchor, and nothing else. It hardcodes `handoff: { ok: 'n/a' }` and
  never sets `authzTier`, so three checks that only `verifyBundle` performs were
  missing from every bundle: handoff closure, authorization tier, and **manifest
  integrity**.

  The visible symptom was `orch watch` disagreeing with `pangolin verify` on the same
  run — `watch` renders the embedded report, `pangolin verify` recomputes. The
  manifest half was more than a disagreement: a forged manifest that `verifyBundle`
  reports as `✗ TAMPERED` with `failure: 'manifest'` rendered as a clean bill, and
  **`orch audit` takes its exit code from `bundle.report.intact`** (as do
  `examples/demo-claims-appeals`), so a caught forgery became a silent pass.

  `assembleBundle` now computes the embedded report with `verifyBundle`. Bundles
  assembled by earlier versions carry the old partial report; re-run `pangolin verify`
  against them, which recomputes and was never affected.

  This makes the embedded report *honest*, not *authoritative*: a report inside a
  bundle read from disk is still attacker-controllable, and a verifier must recompute
  rather than trust it.

- **Every CLI path that shows or gates on a verdict now recomputes it.** `orch watch`
  and `orch audit` previously rendered and exited on the report embedded in the
  bundle. That is sound only while the bundle was assembled moments earlier in the
  same process — and making the embedded report complete (above) also made it *look*
  authoritative, which is the more inviting version of the same trap. Both now
  recompute against the config's own anchor, public key and trusted-time verifier,
  via a shared `verified-bundle` helper that `pangolin verify` uses too. A verdict
  with no anchor to check against now fails loudly instead of returning something
  reassuring.

- **A verifier with no trust anchor no longer reports a healthy run as `TAMPERED`.**
  `verifySignature` returned a bare boolean, so a verifier that could not resolve a
  public key had only one way to say so: `false` — the same answer it gives for a
  signature that genuinely does not match. A perfectly good run rendered as
  `✗ TAMPERED` / `✗ signature false`. "I have no trust anchor" and "this signature
  does not match" are different facts, and a tamper-evidence tool that renders them
  identically cannot adjudicate the one case it exists for. It failed toward a false
  alarm — the safer direction — but it also trains operators to read `✗ signature` as
  "probably the missing key again", which is how a real tamper gets waved through.

  The injected verifier may now return `'n/a'` as well as `true`/`false`:

  | verifier says | `checks.signature.ok` | `intact` | `claim` |
  |---|---|---|---|
  | verified | `true` | ✓ | may be tamper-evident |
  | does not match | `false` | ✗ | tamper-detecting |
  | no trust anchor | `'n/a'` | ✓ | tamper-detecting |

  The signature check now also carries a `detail` distinguishing *no signature on the
  anchored root*, *no verifier configured*, and *unverifiable — no trust anchor
  available*, since the remedy differs. **A real mismatch is unchanged**: still
  `false`, still not `intact`, still `failure: 'signature'`.

  Type-level change only for existing verifiers — returning `boolean` remains valid,
  and the runtime already passed the value through untouched. Consumers that compare
  `checks.signature.ok === true` will now see `'n/a'` where they previously saw
  `false`; consumers that treat `!== true` as tampering should test `=== false`.

- **`pangolin verify` no longer gives the handoff check a green tick when there
  was nothing to check.** A bundle with zero handoff edges reported
  `✓ handoff  no handoff edges`. The label was honest but the glyph was not: `✓`
  renders identically to the checks above it that did real work, so the block read
  as one more verified property. It matters in the case the check exists for — a
  plan that was *supposed* to carry handoff edges and lost them (a converter bug, a
  dropped `needs` block) rendered as a pass, so the check could not fail for the
  failure it is meant to catch. Zero edges now reports `ok: 'n/a'` and renders
  `─ handoff  no handoff edges`, the state `CheckResult` already reserved for
  "prerequisite genuinely absent — never a false ✓".

  **No verdict changes.** `intact` has always tested `handoff.ok !== false`, so
  `'n/a'` cannot fail a bundle that previously passed. Callers that compare
  `checks.handoff.ok === true` will now see `'n/a'` for zero-edge runs.

- **`denied` now counts as terminal in the serve loop.** `TerminalStatus` gained a
  runtime companion, `TERMINAL_STATUSES`, exported from the orchestrator's contracts
  and kept beside the type. Four modules still carry private copies that omit
  `denied` (`operations-api`, `patterns/quorum`, `patterns/scan`, `view/build`);
  those are unchanged, since folding them in would widen what each treats as
  terminal. New code should use the exported set.

## [0.4.0] - 2026-07-28

### Breaking

- `StorageProvider.get` must now throw `StorageNotFoundError` for a missing
  object. `describeDispatch` and `cancelDispatch` are not listed as breaking —
  they have always documented "Unrelated storage errors are re-thrown unchanged",
  so their behaviour did not change.

### Added

- **`@quarry-systems/pangolin-product` — a new package (the sixteenth).** The
  consumer-side read of a dispatch's product: `readOutputSentinel`,
  `parseOutputSentinel`, `assertArtifactRef`, and `fetchDispatchArtifact`.
  Keyed on `storage` + `dispatchId`, so a caller that never held — or has since
  lost — the `fire()` handle can still recover what a dispatch produced.
  Depends only on `pangolin-core`.

  This closes a structural gap: `writeDispatchRecord` runs inside the
  `reconcile` closure, so a fire-and-forget consumer never writes a dispatch
  record and `dispatch.describe()` was permanently unavailable to it. See
  ADR-0020.

- The sentinel wire types (`OutputSentinel`, `OutputEntry`, `BlockOutcome`,
  `MAX_OUTPUT_ENTRIES`) moved from `pangolin-worker` to `pangolin-core` and are
  re-exported from the worker for back-compat. `writeSentinel`'s emitted bytes
  are unchanged.

- ADR-0019 (`target` is an isolation boundary, not a router) and ADR-0020 (the
  dispatch product read is a public, storage-keyed contract).

- `typecheck:test` in the six packages whose `test/` type-checks clean, plus a
  CI step. A package opts in by adding `tsconfig.test.json` and the script.

- `StorageNotFoundError` (constructor `(readonly uri, message?)`, `name` set to
  the class name per the file's structural-matching convention) and
  `isStorageNotFound(err): boolean` in `pangolin-core`. Storage providers and
  their callers now uniformly classify missing objects vs. other errors.

### Changed

- Every package's `lint` script now covers `test/` as well as `src/`. Test
  files were previously neither linted nor type-checked repo-wide.

- `vitest.shared.ts` at the repo root holds the shared test config; each
  package merges it. Replaces `pangolin-orchestrator`'s standalone timeout
  config rather than duplicating that constant per package.

### Fixed

- `pressure-runner` SCENARIO 3 used a wall-clock `sleep(60)` to establish its
  crash window and failed under load; it now waits on the condition. Several
  suites also ran on vitest's 5s default while spawning real `git` subprocesses.
  Together these made `pnpm -r test` fail on a different test most runs.

- `.eslintrc.cjs` declared `rules:` twice, so the second silently overwrote the
  first and a `no-this-alias` allowance had never been in effect.

- **Provider-dependent handling of missing object sentinels is now uniform.**
  Previously, `LocalStorageProvider.getDispatchRecord` on a missing object
  threw an error whose inlined `ENOENT` check callers (`readOutputSentinel` in
  `pangolin-product` and `readDispatchRecord` in `pangolin-client`)
  message-sniffed to produce `{ status: 'absent' }`, while
  `S3StorageProvider.getDispatchRecord` threw `NoSuchKey` with no not-found
  handling. Callers' message-matching `/not found/i` on both caused unrelated
  failures (DNS, throttles, misconfiguration) whose error text happened to match
  to be silently reclassified as absent, turning transient infrastructure errors
  into durable business facts. Both storage providers now consistently throw
  `StorageNotFoundError` on a missing object — the local provider from its
  inlined `ENOENT` check, S3 from its pre-existing type-aware `isNotFound`
  helper — with `S3StorageProvider.getDispatchRecord` gaining the `uri` it
  previously lacked, and callers classify by type instead of message.

## [0.3.1] - 2026-07-24 — Security: patch-capture credential env-scoping

### Fixed

- **Worker credential-exfiltration path in `patch-capture` closed (verified
  exploitable).** The worker's git diff-capture helper spawned `git` with no
  `env` option, inheriting the worker's full `process.env` (`AWS_*`,
  `PANGOLIN_CALLBACK_TOKEN_REF`, …). A workspace-controlled `.git/config` can name
  arbitrary commands git runs as hooks/helpers (e.g. `core.fsmonitor`), so an
  untrusted repo could exfiltrate those credentials during `git add -A`. The
  git subprocess env is now a fixed six-key allow-list
  (`PATH`/`HOME`/`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM`/`GIT_TERMINAL_PROMPT`/`LC_ALL`)
  with no credential of any kind. Adds a unit test, a nested-repo characterisation
  test, an end-to-end escape test proving an `fsmonitor`-hook leak is blocked, and
  an in-image verification script. No API change.

## [0.3.0] - 2026-07-24 — Renamed Agora → Pangolin Scale

### Changed

- **Project renamed from Agora to Pangolin Scale.** All package names change from
  `@quarry-systems/agora-*` to `@quarry-systems/pangolin-*` (13 packages). The CLI
  binary changes from `agora` to `pangolin`; config files change from
  `agora.config.*` to `pangolin.config.*`; the worker image changes from
  `agora-worker` to `pangolin-worker`; the repo URL changes from
  `github.com/QuarrySystems/agora` to `.../pangolin-scale`; the docs URL changes
  from `quarrysystems.github.io/agora` to `.../pangolin-scale`. Historical
  changelog entries below this line retain their original "agora" text as
  intentional residue.

### Added

- **Callback-delivery reliability — correctness, durability, and worker termination (#93, #94).**
  Three slices harden the lifecycle-callback path Pangolin uses to report dispatch outcomes.
  **Correctness (slice A):** the callback HMAC/header contract is fixed so a receiver can verify and parse
  it, and delivery is now honest **at-most-once** (the retry loop and its `(dispatchId, kind)` dedupe key were
  withdrawn). **Durability (slice B):** a failed callback writes a durable
  `dispatches/<id>/undelivered/<kind>.json` record, so a consumer reconciles by polling — no silent drops.
  **Termination (slice C, #94):** the worker (running as PID 1) now traps SIGTERM and mints
  `dispatch.cancelled` through the same `emit()` path when no terminal was produced (flushing an in-flight
  terminal otherwise), guarded by a single-winner claim so a cancel and a late completion can never both be
  delivered; adds an `'aborted'` `DeliveryFailureReason` distinguishing a grace-budget abort from a timeout.
  MVP §7.6 (which documented a SIGTERM handler that never existed) is corrected.

- **Direct-dispatch consumer seam (#93).** The seams an external orchestrator (e.g. ai-os) needs to drive
  Pangolin as an execution + audit substrate without hosting the orchestrator: dispatch de-duplication via
  `DispatchWork.dedupeOnDispatchId` and per-dispatch callback auth via `callbackTokenRef`, plus the
  `emit(event, { signal })` abort seam composed with the internal attempt timeout via `AbortSignal.any`.

- **Engine-free `sealApproval()` pure function (#92)** — the green-lighting primitive extracted so approval
  can be sealed independently of the run engine.

- **Append-able submission — push-then-close open-ended runs (#89).** Opt-in runs that stay open for
  additional items until explicitly closed.

- **`examples/langgraph-changeorder` (#90)** — an external-orchestrator provenance seam demonstrating the
  direct-dispatch pattern end-to-end.

- **Pattern-aware CLI run view — `agora orch render` + live `agora orch watch` (spec: docs/superpowers/specs/2026-06-07-agora-run-view-design.md).**
  Four surfaces landed: **(1) Pre-run view** — `agora orch render <plan.json> [--pattern]` shows the expected DAG incl. dotted ghost respawn arcs under spawn-fix gates; works without a config file.
  **(2) Live watch default** — `agora orch watch` now renders a pattern-aware live view (status glyphs, ghosts materializing on red, per-item model/cost evidence, terminal verify summary) instead of flat JSON; **MIGRATION NOTE:** the previous raw JSON stream is available verbatim via `--json` (new flags also available: `--interval`/`--no-color`/`--no-clear`/`--ascii`/`--pattern`).
  **(3) Additive status field** — status items now carry `depends_on: string[]` (resolved edges, full dependency graph beside the existing filtered `blockedBy`).
  **(4) Driver adoption** — the dogfood-gated harness renders the shared live view instead of flat per-item status lines.

- **Model + cost evidence in dispatch (spec: docs/superpowers/specs/2026-06-06-agora-model-cost-evidence-design.md).**
  Dogfood run 2's manifests sealed `model: { id: '' }` and discarded cost — evidence now answers "which model, at what cost."
  Four surfaces landed: **(1) Core contract** adds `DispatchWork.model?: string` and a shared `RuntimeUsage` type;
  `RuntimeExit.usage` carries actual usage across the adapter boundary. **(2) Executor option** —
  `DispatchExecutor.defaultModel` and pre-fire requested-model resolution (`subagent.model > defaultModel > unset seals ''`);
  manifest `model.id ≡ dispatched work` by construction. **(3) Adapter capture** — claude-code adapter now passes `--model`
  (reserved levels `fast`/`standard`/`max` → haiku/sonnet/opus bare aliases; other strings pass through) and runs
  `claude --print --output-format json`, parsing the envelope best-effort for actual usage (modelUsage/cost/turns/duration),
  verbatim fallback on unparseable output. **(4) Sentinel block** — additive `usage` block sealed after `outputs`
  (models actually run, costUsd, turns, model-time durationMs); absent → byte-identical sentinel. Capture-only
  (not forwarded into ExecutionResult).

- **Block-pipeline worker runtime + the `data` pack (#46, #47).** The worker's
  hardcoded step sequence is now a pipeline runner executing a `PipelineSpec` of
  typed blocks (`agent` / `script` / `capture`; script blocks carry a
  `lens: gate | verify`), with the seal step auto-appended — the default pipeline
  reproduces the previous worker behavior **byte-identically** (golden-tested).
  Declared pipelines register via `registerPipeline` / `client.pipeline.register`
  and the new `agora pipeline register | validate | list` CLI verbs; the chosen
  pipeline is sealed into the dispatch manifest as `pipelineRef` at fire time, and
  declared pipelines emit per-block `blocks[]` evidence in the output sentinel.
  On top of it ships the **`data` pack** — `data.split` / `data.transform` /
  `data.aggregate` shapes and `dataset-ref` edge tags — the second pack, proving
  the engine is domain-general with **zero engine changes**. The
  `examples/data-mapreduce` demo runs a real data job end-to-end, fully offline.

- **Pattern layer — per-queue execution patterns (#43, #45).** A queue can now
  declare an execution pattern (`QueueConfig.pattern`): `staticDag` (identity;
  today's default behavior), `pipeline` (auto-chains the submitted items into a
  linear chain, with a gate policy via `inputs.gate` — a failed gate circles back
  by spawning a bounded fix → re-gate arc), and `mapReduce` (splitter → N map
  items → reduce, where N is data-derived at run time). All dynamic work flows
  through the audited `extendRun` append seam: deterministic ids make replays
  id-skip idempotent, the merged graph is re-validated, and every append lands a
  `'run.extended'` audit entry with actor `pattern:<queue>`. Dynamic work is
  **spawn** — new forward arcs, never in-graph cycles — and provenance closure
  covers spawned graphs the same as static ones. Demos: `examples/pattern-mapreduce`
  (one item grows to five, provenance-verified) and `examples/pattern-dogfood`
  (gated circle-back via spawn).

- **Typed-product handoff (Wave A–C).** Dependent DAGs now hand products node-to-node
  by content-addressed ref: Wave A (#39) added the `outputs/` / `outputRefs` producer
  seam; Wave B (#40) added the `needs` consumer wiring (auto-unioned into `depends_on`
  at submit-normalization, resolved at fire time into `inputs.inputRefs`) plus
  `buildManifest` sealing of those refs; Wave C (#41) closes the provenance loop —
  `verifyBundle(bundle, { anchor })` now checks that every `inputRefs` value in every
  dispatch manifest is a sealed `resultRef` or `outputRef` of a completed item in the
  same run (`checks.handoff.ok`), and `agora verify` proves the chain end-to-end. The
  `examples/handoff-dag` demo ships a runnable two-item plan (edit-a produces a patch;
  apply-patch binds it via `needs` and applies it with `git apply inputs/patch.diff`)
  with an offline CI test that drives the plan to done and asserts `intact: true` and
  `checks.handoff.ok === true`.

- **Bundle verification (`agora verify <bundle.json>`).** A standalone, top-level
  command that re-verifies an exported audit bundle against its **external** anchor
  (never the root embedded in the bundle) and prints a human-readable checklist +
  hash-chained ledger, exiting non-zero on tamper (`--json` for the raw report,
  `--full` for every ledger row). Backed by a new library entry point
  `verifyBundle(bundle, { anchor })` and a `renderVerification()` formatter, both
  exported from `agora-orchestrator`. `VerificationReport` now also carries a
  collect-all `checks` map (`chain` / `root` / `signature` / `anchor`) alongside the
  existing `intact` / `claim` / `failure`.

- **Cron scheduling (`agora orch schedule add|list|rm`).** Recurring submissions
  via a cron scheduler that feeds the existing submission inbox — no new Trigger
  primitive required. Schedules are persisted in a `schedules` SQLite table via a
  config-owned `SqliteScheduleStore`. Catch-up after downtime coalesces to one run
  per slot; runIds are deterministic per slot. UTC / minute granularity;
  single-`serve` assumption.
- **Worker self-verify (`subagentDef.verify`).** After the agent produces its
  edit, the worker can run a subagent-declared, language-agnostic verify command
  (`npm test`, `dotnet test`, `cargo test`, …) over its own edit and seal
  `{ passed, report, durationMs }` into the output sentinel; surfaced on the
  dispatch result and item `status` / `watch`. **Report-only** — a failed verify
  does not change the dispatch outcome. The patch is captured _before_ verify so
  build artifacts never pollute it; registered secrets are redacted from the
  report; a new `verify.ran` worker event is emitted. Set it via
  `client.subagent.register({ verify: { command, timeout } })`.

- **Red gates block dependents + live gated circle-back harness (spec: docs/superpowers/specs/2026-06-06-dogfood-run3-gated-circleback-design.md).**
  Engine surface: `computeNewlyReady` and `computeSkipped` now treat a `done` + `verify.passed === false` + `inputs.gate.onRed === 'spawn-fix'`
  dependency as failed-like, blocking its dependents' readiness and triggering the skip cascade — closing the gap where findings-by-provenance and downstream
  skip+remap were mutually exclusive in the offline proof. Scoped gate-aware change with a data-edge exemption: dependents consuming the gate's own outputs
  (via `needs[*].from === gate` + `select.kind === 'output'`) remain unblocked, permitting the spawned fix to consume findings.
  Harness surface: **`examples/dogfood-gated`** ships the run-3 live harness — a 3-node gated plan on agora's own tree (docs explanation page → opus fact-check
  gate with `verify: test ! -s outputs/findings` → announce), pipeline pattern with spawn-fix, driver asserting provenance closure over the grown graph, the
  red-path remap (dependents skipped, fix spawned with gate outputs remapped), and live per-dispatch model/cost evidence (first table sealing manifest-requested +
  worker-captured models and costUsd). The harness is ready; the live run has not yet occurred.

- **Execution patterns** — new explanation page (`docs-site/src/content/docs/explanation/execution-patterns.md`) documenting how queue-level execution patterns (`staticDag`, `pipeline`, `mapReduce`) layer above the tick engine: the Pattern contract, the `extendRun` seam, `run.extended` audit entries, the gate/respawn circle-back, and the forward-arc-never-rewind invariant; see the design spec at docs/superpowers/specs/2026-06-06-dogfood-run3-gated-circleback-design.md.

- **`AwsS3MailboxClient` / `AwsS3LockClient` promoted from the offload-minio example into `@quarry-systems/agora-storage-s3` (exported; integration suites moved with them).** The example README's own "second consumer" promotion trigger, fired by the new `deploy/serve-stack/` — an always-on serve deployment for WSL2 with hardened compose (restart policies, named volumes, pinned `:main` worker image), persisted-signer serve config publishing its public key for remote `agora verify`, laptop client kit + smoke test, and a full WSL2 runbook (keep-alive, SSH tunnel, crash-recovery drill, update procedure). See docs/superpowers/specs/2026-06-07-agora-serve-stack-design.md for the design and deployment topology. The deployment artifacts are ready; the live deployment on the host is a runbook execution and has not been performed.

## [0.1.0] - 2026-06-01

First public, **source-available** release (BSL 1.1). All thirteen packages
published to npm under `@quarry-systems/agora-*`.

### Added

- **Offload orchestrator (`agora-orchestrator`).** `agora orch serve | submit |
watch | cancel | audit` — a long-running driver runs a DAG of agent tasks
  unattended: dependency ordering, parallel fan-out serialized by declared
  resource locks, retry/backoff with a `skipped` cascade, a reviewable patch
  artifact per task (`result_ref`), and an exportable, self-verifying audit bundle.
- **Tamper-evidence.** Signed dispatch manifest + Merkle-rooted audit log behind a
  pluggable `AuditAnchor` seam. Tamper-detecting by default; tamper-evident at the
  external-immutable S3 Object Lock tier.
- **Caller SDK (`agora-client`).** `AgoraClient` — register capabilities,
  subagents, and env bundles, then `dispatch`. The same code path runs locally
  against Docker and in production against Fargate + S3 via swappable provider
  seams (compute / storage / credentials / result-sink / secret-store).
- **CLI (`agora-cli`)** and **MCP server (`agora-mcp`)** — nine run-time,
  orchestration-safe MCP tools; privileged ops (`register` / `assign`) and the
  operator `audit` action are kept off the AI tool surface, enforced by a CI
  allowlist.
- **Worker runtime (`agora-worker`)** and the MVP **`agora-runtime-claude-code`**
  adapter (prompt rendering, `claude --print`, `needs_input` sentinel).
- **Providers:** `agora-providers-fargate`, `agora-providers-local-docker`
  (compute); `agora-storage-s3`, `agora-storage-local` (storage);
  `agora-providers-aws-creds` (credentials); `agora-secret-store` (SecretStore
  seam + inline/local implementations).
- **S3 server-side encryption.** `S3StorageProvider` accepts an `encryption`
  option (SSE-S3, or customer-managed SSE-KMS); omitting it inherits the bucket
  default (no-downgrade).
- **Types-only contract (`agora-core`)** that every other package depends on.
- **Documentation site** — https://quarrysystems.github.io/agora/ (tutorials,
  how-to, reference, explanation, ADRs, roadmap).
- **Licensing.** Source-available under the Business Source License 1.1 (no
  hosted-service Additional Use Grant; Change Date four years out → Apache-2.0).

### Known limitations

- End-to-end **Fargate + S3 parity is operator-deferred** — the production
  components exist and are documented but have not been run end-to-end by the
  maintainers; no concrete `S3LockClient` adapter ships (interface only).
- The **`dev` pack / typed-subagent substrate** is scaffolded but not yet
  dispatchable (placeholder worker image; `outputSchema` declared, not enforced).
- **Effect-tier policy** is computed but not yet enforced.
- **Pre-1.0 (`0.x`):** interfaces may change between minor versions.

[0.4.0]: https://github.com/QuarrySystems/pangolin/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/QuarrySystems/pangolin/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/QuarrySystems/pangolin/compare/v0.2.0...v0.3.0
[0.1.0]: https://github.com/QuarrySystems/pangolin/releases/tag/v0.1.0
