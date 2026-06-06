# Roadmap

> **Status posture.** agora is **source-available** under the Business Source
> License 1.1. **V1 is shipped** — the offload orchestrator runs unattended,
> escapes a reviewable patch per task, and produces a verifiable audit bundle.
> What follows is **additive**: the V1.1 layer is a strict superset of what V1
> ships, so it accretes without a refactor. This file says what is solid today,
> what is planned next, and what is deliberately left as a branch to be pulled
> when a real use case needs it.
>
> No dates. Items move from *Later* → *Next* → *Now* as the work is pulled, not
> on a schedule.

agora is **mechanism, not policy**. It ships enforcement points and primitives;
it does not own roles, sharing, scheduling policy, or who-can-do-what. That is by
design and shapes everything below.

---

## Now — shipped in V1

The local-Docker acceptance path is proven live: safe fan-out under resource locks,
a per-edit patch artifact (`result_ref`), and a verifiable **tamper-detecting**
audit bundle. Delivered across five waves (PRs #18, #19, #21, #22, #23; V1 marked
shipped in #24). Since the V1 cut, three more waves have landed on `main`
(unreleased): the typed-product handoff (#39–#41), the pattern layer (#43/#45),
and the block-pipeline runner + `data` pack (#46/#47) — the last three bullets
below.

- **`serve` driver** — the long-running process; sole writer of the SQLite
  run-state, polls the submission inbox, runs the reconcile tick loop, exits
  cleanly on signal.
- **Submission transport** — clients write a Run spec to a storage prefix;
  `serve` ingests and publishes status/completion records. **No inbound
  networking** to the container. Identical on local FS and S3.
- **Sandbox escape** — the worker captures the workspace diff, uploads it as a
  content-addressed artifact, and surfaces it as `result_ref`.
- **Retry / backoff** — per-item attempt counter, configurable `maxAttempts`,
  exponential backoff; exhausted items go `failed` and their dependents `skipped`.
- **Operator surface** — CLI `agora orch serve | submit | status | watch | cancel
  | audit`; the three client MCP tools (`agora_orchestrator_submit | _status |
  _watch`). `audit` is deliberately **not** on MCP — auditing is an operator
  action, not an AI-loop action. A CI allowlist check fails if any
  privileged/service method becomes MCP-reachable.
- **Persistent run-state** — SQLite on the service's own volume.
- **The `default` queue** — concurrency configured at construction. Named queues
  remain a contract, not yet a feature.
- **Compliance & audit controls (the edge)** — signed dispatch manifest,
  Merkle-rooted audit log with a pluggable `AuditAnchor` tamper-evidence seam,
  actor identity on every operation, and `agora orch audit` evidence export.
  **Encryption-at-rest on S3 writes is agora-set** — `S3StorageProvider` takes an
  `encryption` option to set server-side encryption (SSE-S3, or customer-managed
  SSE-KMS via `{ mode: 'aws:kms', kmsKeyId }`); when unset it inherits the bucket
  default (no-downgrade). Other at-rest layers — the SQLite run-state volume and
  staged secrets — remain **substrate-provided** (encrypted EBS/EFS). The claim is
  **"compliance-ready," never "compliant" or "certified."**
- **Headline demo** — [`examples/offload-fanout`](examples/offload-fanout/):
  one `submit` exercising locks + deps + concurrency + isolation + patch escape,
  producing a verifiable audit bundle.
- **BSL packaging** — root `LICENSE`, `BUSL-1.1` in every package, `LICENSING.md`.
- **Typed-subagent substrate (scaffolded, not yet operational)** — the
  `SubagentShape` contract, the `PackRegistry`, construction-time shape
  validation, and the `dev` pack's `dev.code-edit` / `dev.verify` shapes ship as
  code; the engine resolves a `WorkItem.subagentShape` and validates its `inputs`
  against the shape's schema. **It is not yet dispatchable** — the dev shapes carry
  a placeholder worker-image digest and their `outputSchema` is declared but not
  enforced. Making it runnable is V1.1 work (below). Today, V1 runs **plain
  registered subagents** named in `WorkItem.inputs`.
- **Effect-tier policy (computed, not enforced)** — the `EffectTier` vocabulary
  (`pure` / `read-impure` / `write-impure`) *and* the `effectTierPolicy()`
  derivation (`cacheable` / `needsSnapshot` / `gated`) ship as code, and the engine
  computes the policy for each item — but the result is currently **discarded**
  (`tick.ts`: `void effectTierPolicy(…)`, `// TODO(PR6)`). Nothing caches, snapshots,
  or gates on it yet. Acting on it is V1.1 (below).
- **Cron scheduling** — `agora orch schedule add|list|rm` CLI verbs; schedules
  persisted in a `schedules` SQLite table via a config-owned `scheduleStore`
  (default `SqliteScheduleStore`). The cron scheduler acts as a Run *producer*
  feeding the existing submission inbox — no new Trigger primitive. Catch-up
  coalesces to one run after downtime; runIds are deterministic per slot. UTC /
  minute granularity; single-`serve` assumption.
- **Typed-product handoff** — WorkItems declare `needs`
  (`{ from, select: patch | output }`, auto-unioned into `depends_on`); products
  are resolved at fire time, materialized into the consumer's workspace at
  `inputs/<key>`, sealed into the dispatch manifest as content-addressed
  `inputRefs`, and `agora verify` proves **provenance closure** — every consumed
  ref is a sealed product of a completed item in the same run. This also closes
  the previously-deferred per-dispatch artifact I/O gap (content-addressed
  `outputs/` capture in, `inputs/<key>` overlay out, both in the manifest).
  Pre-flight: `agora orch validate plan.json`. Demo:
  [`examples/handoff-dag`](examples/handoff-dag/).
- **Per-queue execution patterns** — `QueueConfig.pattern`: `staticDag`
  (identity; the default), `pipeline` (auto-chaining plus an `inputs.gate` policy
  with bounded circle-back), `mapReduce` (splitter → N data-derived map items →
  reduce). Dynamic work flows through the audited `extendRun` append seam
  (id-skip idempotent, validated merged graph, `'run.extended'` audit entries
  with actor `pattern:<queue>`); it is **spawn** — new forward arcs, never
  in-graph cycles — and provenance closure covers spawned graphs. Demos:
  [`examples/pattern-mapreduce`](examples/pattern-mapreduce/),
  [`examples/pattern-dogfood`](examples/pattern-dogfood/).
- **Block-pipeline worker runtime + the `data` pack** — the worker's hardcoded
  steps are now a pipeline runner over typed blocks (`agent` / `script` /
  `capture`; script lens `gate | verify`), byte-identical to the old path
  (golden-tested), with seal auto-appended; declared pipelines register via
  `registerPipeline` / `agora pipeline register|validate|list`, are sealed into
  the manifest as `pipelineRef` at fire, and emit per-block `blocks[]` evidence.
  The **`data` pack** (`data.split` / `data.transform` / `data.aggregate` shapes,
  `dataset-ref` edge tags) is the second pack — domain-generality with zero
  engine changes. Demo: [`examples/data-mapreduce`](examples/data-mapreduce/)
  (fully offline, real end-to-end).

### Known gap in V1

- **End-to-end Fargate + S3 parity is operator-deferred.** Every production
  component exists in code (`FargateProvider`, `S3StorageProvider`,
  `AwsCredentialProvider`, and the `S3ObjectLockAnchor` for the
  external-immutable audit tier), but the maintainers have **not** run the full
  Fargate+S3 path end-to-end. Treat the
  [Deploy to Fargate + S3](https://quarrysystems.github.io/agora/how-to/deploy-fargate-s3/)
  guide as a first-run guide, not a tested recipe. Note: no concrete
  `S3LockClient` adapter ships — the interface is provided; you implement it.

---

## Next — V1.1 (additive, no refactor)

The V1.1 layer is a strict superset of V1. Nothing below requires changing what
V1 ships.

> **Seam vs. implementation (open-core).** Several items below — the `Authorizer`
> seam, the enterprise compliance layer, and the `WitnessAnchor` tier — ship the
> *extension point* in the open engine while their *production implementation*
> (packaged RBAC, SSO, retention/attestation/evidence-export, a managed witness
> tier) is an **Enterprise module**, distributed separately under a commercial
> license. The engine runs fully standalone without them; that is the point of
> the seams. Items carrying this split are tagged **[seam free · impl Enterprise]**.

- **Live worker dogfood** — run a real DAG plan end-to-end with LLM workers.
  The shipped demos prove the engine offline (scripted executors); the next step
  is the same plans driven by actual agent dispatches. **This is the first item
  to pull into V1.1.**
- **Adapter blocks** — a fourth block kind in the pipeline runner that delegates
  to an adapter rather than `agent` / `script` / `capture`. Deferred with a named
  trigger — pulled when a concrete adapter use case arrives.
- **Tier-2 custom code blocks** — user-supplied code blocks in declared
  pipelines, beyond the shipped block kinds. Deferred.
- **`oneOf` needs selectors** — OR-readiness on `needs` (consume whichever of
  several producers completes first). Deferred — needs an OR-readiness design
  pass first.
- **Operationalize the `dev` pack** — the `dev.code-edit` / `dev.verify` shapes and
  the `PackRegistry` already exist in code (see "Now"), but the shapes are **not
  dispatchable yet**: pin the real worker-image digest (currently a `PLACEHOLDER`)
  and enforce each shape's `outputSchema` via `.agora/output.json`.
- **Full typed output (enforcement)** — the worker **already writes**
  `.agora/output.json` (a fixed `{schemaVersion, patchRef, summary}` sentinel) and
  the executor reads `patchRef` from it to surface `result_ref` — that path is live.
  Deferred: validating the sentinel against each shape's `outputSchema`, and the
  richer `output` / `intents` / `signals` products (the types exist; nothing
  enforces or consumes them yet).
- **The autonomous-PR layer** — `Intent` / `IntentInterpreter`, the `dev.open-pr`
  interpreter, the auto-merge-test-only / human-approve policy, and the CLI
  `approve` verb. The `Intent` *type* exists; no interpreter ships yet. This is the
  "lean-runner cut" deferred from V1.
- **Cost accounting / budget enforcement.**
- **Effect-tier enforcement** — the vocabulary and the `effectTierPolicy()`
  derivation already ship and are computed per item (see "Now"), but the result is
  discarded. V1.1 makes the engine *act* on it: cache `pure` work, snapshot live
  state before `read-impure`, gate `write-impure` intents through interpreter policy.
- **`Authorizer` seam** — an implementor-filled authorization policy. agora ships
  the chokepoint (the operations API) and identity primitives (`actor`, the
  client/service privilege split); it never owns roles. V1 is single-operator
  ("whoever launched"). **[seam free · impl Enterprise]** — the seam is open; a
  packaged role-based-access implementation is an Enterprise module.
- **Compliance deepening** — extend customer-managed encryption **beyond S3
  objects** (S3 SSE/SSE-KMS already ships; deferred: envelope-encrypted staged
  secrets + encrypted run-state), full role-based RBAC, automated retention/purge
  policy, SIEM/log-export integrations, and a
  **Bedrock-backed `RuntimeAdapter`** (keeps the model call inside a customer's
  AWS BAA boundary). All additive via existing seams. The SOC2 audit / HIPAA risk
  assessment themselves are organizational process, not software. **[seam free ·
  impl Enterprise]** — the encryption/anchor/runtime seams are open; packaged
  RBAC, SSO, retention/purge, attestation/evidence-export, and SIEM/log-export
  tooling are Enterprise modules.
- **`WitnessAnchor` audit tier** — pushes the audit root to a cross-org witness
  (RFC 3161 TSA / transparency log) for customers who won't trust even their own
  WORM admin. Additive third tier above `external-immutable`. **[seam free · impl
  Enterprise]** — the anchor seam is open; a managed witness/transparency-log
  implementation is an Enterprise module.

---

## Later — branches (pulled when a real use case needs them)

These require **no refactor** when pulled — that is what the architecture bought.

- Additional executors: `shell`, `batch-api`, `dag-plan`.
- Additional packs beyond `dev` and `data`.
- Predicate / signal / event triggers.
- Named queues beyond `default`; rate-limiting.
- `pause` / `resume`.
- An HTTP submission transport (V1 is storage-prefix polling only).
- The `Claim` core type + Mneme integration.

---

## Versioning & stability

- agora is **pre-1.0 (`0.x`)**. Interfaces may change between minor versions
  until 1.0.
- `agora-core` is the **types-only contract**; every other package depends only
  on it. Breaking changes are introduced there first and called out in the
  changelog.

## License & the Change Date

agora is licensed under **BSL 1.1**. The Additional Use Grant permits all use
**except offering agora as a hosted/managed orchestration service.** The
**Change Date is four years from first publish**, at which point the license
converts to **Apache-2.0**. Self-hosting is also the compliance model: regulated
data never leaves your account. See [`LICENSING.md`](LICENSING.md) and
[ADR-0017](https://quarrysystems.github.io/agora/explanation/decisions/0017-source-available-bsl/).

## Influencing the roadmap

Items move because a concrete use case pulls them. If you need something in
*Next* or *Later* sooner, open an issue describing the use case — that is how a
branch gets pulled forward.
