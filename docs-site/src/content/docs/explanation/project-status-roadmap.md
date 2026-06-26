---
title: Project status & roadmap
description: What's shipped in V1, what's planned next (V1.1, additive), and what's left as a branch — plus the BSL posture and stability guarantees.
---

Pangolin Scale is **source-available** under the Business Source License 1.1. **V1 is
shipped** — the offload orchestrator runs unattended, escapes a reviewable patch
per task, and produces a verifiable audit bundle. Everything planned beyond V1 is
**additive**: the V1.1 layer is a strict superset of what V1 ships, so it accretes
without a refactor.

There are no dates. Items move from *Later* → *Next* → *Now* as the work is
pulled by a real use case, not on a schedule.

:::note
Pangolin Scale is **mechanism, not policy.** It ships enforcement points and primitives;
it does not own roles, sharing, scheduling policy, or who-can-do-what. That is by
design and shapes the whole roadmap.
:::

## Now — shipped in V1

The local-Docker acceptance path is proven live: safe fan-out under resource locks, a
per-edit patch artifact (`result_ref`), and a verifiable **tamper-detecting**
audit bundle.

- **`cron` scheduling** — `pangolin orch schedule add|list|rm`; `serve` fires due
  schedules through the existing submission inbox (same path as a manual submit).
  Catch-up after downtime coalesces to ONE run for the most-recent missed slot.
  Deterministic per-slot run id (`<scheduleId>@<slotISO>`) deduplicates
  double-emits via `submitRun`'s existing idempotency guard. Schedules persist
  in a `schedules` table on the run-state SQLite DB.
- **Typed-product handoff** — dependent DAG nodes consume upstream products by
  content-addressed reference: `needs` wiring on the `WorkItem`
  (auto-unioned into `depends_on` at submit), the `outputs/` capture seam
  (content-addressed `outputRefs` per item) and the `inputs/<key>`
  materialization seam in the worker, consumed refs sealed in the dispatch
  manifest, and a **provenance-closure** check in `pangolin verify` proving every
  consumed ref equals a sealed product of a verified item in the same run. See
  the [plan.json reference](/pangolin/reference/plan-json/#needs--typed-product-handoff).
- **The execution-pattern layer** — per-queue execution patterns
  (`static-dag`, `pipeline`, `map-reduce`, `quorum`) over the unchanged engine.
  Dynamic fan-out and circle-back are **audited spawn** through the internal
  `extendRun` seam: spawned items are validated against the merged graph,
  actor-attributed as `pattern:<queue>`, and recorded as `run.extended` audit
  entries naming the cause item. Growth is always new forward arcs — never
  cycles — and provenance closure covers spawned graphs with zero new
  verification code. See
  [How an offload run executes](/pangolin/explanation/how-offload-runs/#execution-patterns-and-audited-spawn).
- **`quorum` independent-review + human approval** — an N-of-M review pattern: a
  subject's product is reviewed by independent reviewers, and the `commit` item
  is spawned only when at least `threshold` reviewers approve; sub-threshold
  tallies either circle back (`spawn-fix`) or seal the rejection as final history
  (`block`). The per-reviewer verdicts and the tally are **sealed evidence**.
  Reviewers can be AI subagents with distinct `subagentShape`s (independent-
  validation), or a **`HumanApprovalExecutor`** whose `reconcile()` stays pending
  until a natural person decides — sealing the **approver identity + timestamp**
  (the four-eyes / human-oversight tier). Runnable offline ($0) via
  [`examples/pattern-quorum`](https://github.com/quarrysystems/pangolin/tree/main/examples/pattern-quorum).
- **Append-able (open-ended) runs** — opt-in `Run.openEnded` ingestion: an
  external producer pushes items into an already-running, audited run *over time*
  through the optional `AppendChannel` transport
  (`extend` / `pollExtends` / `ackExtend`, kept separate so existing transports are
  unaffected), then issues a `close` control signal to seal one bundle over the
  grown graph. Closed-plan runs are **unchanged** — they still seal at all-terminal;
  only open-ended runs defer sealing until close (seal-gate =
  `all-terminal && (!openEnded || closed)`). `producerExtend` reuses the same
  audited `extendRun` path, so provenance closure covers producer-grown graphs
  with **zero new verification code**. Proven offline ($0, fake in-proc executor)
  by [`examples/appendable-stream`](https://github.com/quarrysystems/pangolin/tree/main/examples/appendable-stream).
- **The block-pipeline runner + the data pack** — the worker's execution core
  is a runner of typed block-pipelines (`PipelineSpec`: `agent` / `script` /
  `capture` blocks over a structural, auto-appended `seal`). The legacy steps
  are the default pipeline, **byte-identical** to before (golden-tested);
  declared pipelines are registered (`pangolin pipeline register|validate|list`,
  `client.pipeline.register`), pinned by content hash, sealed into the
  manifest as `pipelineRef`, and add per-block `blocks[]` evidence to the
  output sentinel. The `data` pack (CSV split → transform → aggregate riding
  map-reduce, scripts only, fully offline) is the **second-domain proof** the
  pack architecture demanded. See
  [Dispatch lifecycle](/pangolin/reference/dispatch-lifecycle/#the-block-pipeline-runner).
- **`serve` driver** — long-running process; sole writer of the SQLite run-state,
  polls the submission inbox, runs the reconcile tick loop, exits cleanly on signal.
- **Submission transport** — clients write a Run spec to a storage prefix; `serve`
  ingests and publishes status/completion records. **No inbound networking on the
  run-submission path** — runs arrive solely over the mailbox; identical on local FS
  and S3. (The serve container separately exposes an *opt-in* HTTP observability
  endpoint — `/healthz`, `/readyz`, `/metrics` — which carries no submission path; see
  Observability below.)
- **Sandbox escape** — the worker captures the workspace diff, uploads it as a
  content-addressed artifact, and surfaces it as `result_ref`.
- **Retry / backoff** — per-item attempt counter, configurable `maxAttempts`,
  exponential backoff; exhausted items go `failed`, dependents `skipped`.
- **Operator surface** — CLI `pangolin orch serve | submit | status | watch | cancel
  | audit`; three client MCP tools (`pangolin_orchestrator_submit | _status |
  _watch`). `audit` is deliberately not on MCP. A CI allowlist check fails if any
  privileged/service method becomes MCP-reachable — see
  [The privilege boundary](/pangolin/explanation/privilege-boundary/).
- **Persistent run-state** — SQLite on the service's own volume.
- **The `default` queue** — concurrency configured at construction. Named queues
  remain a contract, not yet a feature.
- **Compliance & audit controls** — signed dispatch manifest, Merkle-rooted audit
  log with a pluggable `AuditAnchor` seam, actor identity on every operation, and
  `pangolin orch audit` evidence export. See
  [Audit & guarantee tiers](/pangolin/explanation/audit-guarantee-tiers/).
  **Encryption-at-rest on S3 writes is Pangolin Scale-set** — `S3StorageProvider` takes an
  `encryption` option (SSE-S3, or customer-managed SSE-KMS via
  `{ mode: 'aws:kms', kmsKeyId }`); unset inherits the bucket default (no-downgrade).
  Other at-rest layers (SQLite run-state volume, staged secrets) remain
  substrate-provided. The claim is **"compliance-ready," never "compliant" or
  "certified."**
- **Headline demo** — a single `submit` exercising locks + deps + concurrency +
  isolation + patch escape, producing a verifiable audit bundle. Walk it in
  [Your first offload run](/pangolin/tutorials/first-offload-run/).
- **BSL packaging** — root `LICENSE`, `BUSL-1.1` in every package.
- **Typed-subagent substrate (scaffolded, not yet operational)** — the
  `SubagentShape` contract, the `PackRegistry`, construction-time validation, and
  the `dev` pack's `dev.code-edit` / `dev.verify` shapes ship as code; the engine
  resolves a `WorkItem.subagentShape` and validates its `inputs` against the
  shape's schema. **Not yet dispatchable** — the dev shapes carry a placeholder
  worker-image digest and their `outputSchema` is declared but not enforced.
  Making it runnable is V1.1 (below); today V1 runs plain registered subagents
  named in `WorkItem.inputs`.
- **Effect-tier policy (computed, not enforced)** — the `EffectTier` vocabulary
  and the `effectTierPolicy()` derivation (`cacheable` / `needsSnapshot` / `gated`)
  ship as code, and the engine computes the policy per item — but the result is
  currently **discarded** (`tick.ts`: `void effectTierPolicy(…)`, `// TODO(PR6)`).
  Nothing caches, snapshots, or gates on it yet. Acting on it is V1.1 (below).

### Seal-compliance hardening — shipped

Two items from the seal-compliance hardening list — previously listed as gaps — are
now built:

- **Trusted time (#1)** — the audit log can attach an **RFC 3161 trusted-time
  token** via a pluggable `TimestampAuthority` seam (`NoTimestampAuthority` floor —
  no token, no egress; `Rfc3161TimestampAuthority({url})` calls a real TSA;
  `LocalCaTimestampAuthority` is the offline/test impl). Trusted time is a
  **separate report dimension** — `timeTier: 'asserted' | 'tsa-attested'` —
  **orthogonal to the tamper claim**: a failed or absent timestamp never downgrades
  a tamper-evident/tamper-detecting verdict; it only sets `timeTier`.
- **Standalone verifier (#6)** — `@quarry-systems/pangolin-verify`, a 14th package
  with **zero orchestrator dependency** (depends only on `pangolin-core`), lets an
  auditor run `npx @quarry-systems/pangolin-verify <bundle.json>` without the engine.
  Repo-root `VERIFICATION.md` is the auditor reimplementation spec.

### Observability — shipped

A full dispatch-observability stack, all opt-in and dependency-light:

- **Telemetry lifecycle seam** — the client dispatch path emits all six
  `LifecycleEvent`s (`accepted` / `started` / `finished` / `needs_input` / `failed` /
  `cancelled`) through one guarded `emitLifecycleEvent` chokepoint; opt-in via the
  `telemetry` option on `PangolinClient` (`ConsoleTelemetryHook` writes one JSON line
  per event to stderr; default `NoopTelemetryHook` drops them). See
  [Dispatch lifecycle](/pangolin/reference/dispatch-lifecycle/#the-6-lifecycle-events-closed-vocabulary).
- **Metrics layer** — a dependency-light `MetricsRecorder` seam + `InMemoryMetricsRecorder`
  (`snapshot()`); a `MetricsTelemetryHook` + `combineTelemetryHooks` bridge dispatch
  metrics, and the orchestrator's `metrics?` option instruments the engine + seal. Ten
  Prometheus-shaped series (dispatch started / completed`{outcome}` / duration, queue
  depth, running, retried, skipped, deadline-exceeded, runs-completed,
  audit-dropped-appends) — catalogued in
  [Observing the serve container](/pangolin/explanation/how-offload-runs/#observing-the-serve-container).
- **HTTP health/readiness/metrics endpoint** — `serve()` takes an opt-in
  `http: { port, metricsSnapshot }` option exposing `GET /healthz` (heartbeat liveness —
  detects a wedged tick loop), `/readyz` (readiness — red when a tick can't reach
  SQLite/the mailbox), and `/metrics` (Prometheus text) on `PANGOLIN_HTTP_PORT`
  (default 9464). Unauthenticated by design — bind to a trusted/internal interface;
  `deploy/serve-stack` wires the Docker `HEALTHCHECK`.
- **Trace correlation** — every lifecycle event and the dispatch record carry an
  optional `trace { traceId, runId?, itemId? }` so one logical unit of work
  (run → item → dispatch) is followable on the live stream; orchestrated →
  `traceId = runId`, standalone → `traceId = dispatchId`. Correlation only, not OTel spans.

Out of scope (deferred): worker-side trace propagation, W3C `traceparent` hex, and
Prometheus/OTel **push** adapters (the current posture is scrape-pull of `/metrics`).

### Cleared (2026-06-13): the external-immutable tamper-evident tier is proven

The tamper-evident leave-gate ran end-to-end against a **real S3 Object Lock
(COMPLIANCE) bucket** via the shipping `AwsS3LockClient` + `S3ObjectLockAnchor`: a clean
run earns **`tamper-evident`**, and a chain-consistent forge — even when the attacker
re-anchors a forged root as a new object version — is caught as **`root-mismatch`** (the
claim collapses to `tamper-detecting`). Clearing it **found and fixed a real bug**: the
anchor read the *latest* object version, which an attacker with bucket write access can
forge by adding a new version (Object Lock keeps the original undeletable but does not
block new versions); the anchor now **version-pins to the immutable original version**.
Locked in by a CI contrast test and a `PANGOLIN_S3_ENDPOINT`-gated MinIO round-trip.

### Known gap in V1

The **full Fargate + S3 production deploy is still operator-deferred.** Every component
exists in code (`FargateProvider`, `S3StorageProvider`, `AwsCredentialProvider`), but the
maintainers have not run the complete Fargate+S3 deploy path end-to-end. Treat
[Deploy to Fargate + S3](/pangolin/how-to/deploy-fargate-s3/) as a first-run guide, not a
tested recipe. Seal-compliance items **#2–#5** (authz-in-evidence, retention policy,
access-logging, KMS key custody) also remain unbuilt.

## Next — V1.1 (additive, no refactor)

A strict superset of V1; nothing below changes what V1 ships.

:::note[Seam vs. implementation (open-core)]
Several items below — the `Authorizer` seam, the enterprise compliance layer, and
the `WitnessAnchor` tier — ship the *extension point* in the open engine while
their *production implementation* (packaged RBAC, SSO,
retention/attestation/evidence-export, a managed witness tier) is an **Enterprise
module**, distributed separately under a commercial license. The engine runs fully
standalone without them — that is the point of the seams. Items carrying this
split are tagged **[seam free · impl Enterprise]**.
:::

- **Live worker dogfood** — the handoff / pattern / block-runner stack is
  proven offline (fake and in-process executors, zero API credits); the first
  real DAG-plan run against live workers is the actual validation. **First
  item to pull into V1.1.**
- **Adapter blocks** — constructing edge-type adapters where typed-product
  tags mismatch (today a mismatch is rejected with a precise error naming the
  gap). *Named trigger:* a pack declaring tags that actually mismatch.
- **Tier-2 custom code blocks** — `pangolin block register`, module loading /
  sandboxing / conformance in the worker. The id namespace and
  content-addressing posture are already reserved by the block-runner design.
  *Named trigger:* a third-party pack needing behavior the built-in blocks
  can't express.
- **`oneOf` needs selectors** — a richer declarative `select` for a
  **pre-submitted** item whose source varies at runtime (consume the
  fast-path's product, else the fallback's), resolved by the same pure
  resolve-at-fire with the chosen ref sealed as today. The real cost is
  OR-readiness semantics in the engine. *Named trigger:* a concrete consumer
  with pre-submitted conditional wiring.
- **Operationalize the `dev` pack** — the `dev.code-edit` / `dev.verify` shapes and
  the `PackRegistry` already exist in code (see "Now"), but aren't dispatchable yet:
  pin the real worker-image digest (currently a `PLACEHOLDER`) and enforce each
  shape's `outputSchema` via `.pangolin/output.json`.
- **Full typed output (enforcement)** — the worker **already writes**
  `.pangolin/output.json` (a fixed `{schemaVersion, patchRef, summary}` sentinel) and
  the executor reads `patchRef` to surface `result_ref` — that path is live.
  Deferred: validating it against each shape's `outputSchema`, and the richer
  `output` / `intents` / `signals` products (types exist; nothing enforces them yet).
- **The autonomous-PR layer** — `Intent` / `IntentInterpreter`, the `dev.open-pr`
  interpreter, the auto-merge-test-only / human-approve policy, the CLI `approve`
  verb. The `Intent` *type* exists; no interpreter ships yet. The "lean-runner cut"
  deferred from V1.
- **Cost accounting / budget enforcement.**
- **Effect-tier enforcement** — the vocabulary and the `effectTierPolicy()`
  derivation already ship and are computed per item (see "Now"), but the result is
  discarded. V1.1 makes the engine *act* on it: cache `pure` work, snapshot before
  `read-impure`, gate `write-impure` intents through interpreter policy.
- **`Authorizer` seam** — implementor-filled authorization policy at the existing
  operations-API chokepoint. V1 is single-operator ("whoever launched").
  **[seam free · impl Enterprise]** — the seam is open; a packaged role-based-access
  implementation is an Enterprise module.
- **Compliance deepening** — extend customer-managed encryption **beyond S3
  objects** (S3 SSE/SSE-KMS already ships; deferred: envelope-encrypted staged
  secrets + encrypted run-state), full role-based RBAC, automated retention/purge,
  SIEM/log-export, and a
  **Bedrock-backed `RuntimeAdapter`** (keeps the model call inside a customer's AWS
  BAA boundary). All additive via existing seams. **[seam free · impl Enterprise]**
  — the encryption/anchor/runtime seams are open; packaged RBAC, SSO, retention/purge,
  attestation/evidence-export, and SIEM/log-export tooling are Enterprise modules.
- **`WitnessAnchor` audit tier** — pushes the audit root to a cross-org witness
  (RFC 3161 TSA / transparency log); an additive third tier above
  `external-immutable`. **[seam free · impl Enterprise]** — the anchor seam is open;
  a managed witness/transparency-log implementation is an Enterprise module.

## Later — branches (pulled when a use case needs them)

No refactor required when pulled — that is what the architecture bought.

- Additional executors: `shell`, `batch-api`, `dag-plan`.
- Additional packs beyond `dev` and `data`.
- Predicate / signal / event triggers.
- Named queues beyond `default`; rate-limiting.
- `pause` / `resume`.
- An HTTP submission transport (V1 is storage-prefix polling only).
- Continuous **epoch-window sealing** for never-closing open-ended runs — today
  an open-ended run seals once, at `close`; a long-lived run that must be sealed
  continuously into a growing ledger is the additive next step.
- The `Claim` core type + Mneme integration.

## Versioning & stability

- Pangolin Scale is **pre-1.0 (`0.x`)** — interfaces may change between minor versions
  until 1.0.
- `pangolin-core` is the **types-only contract**; every other package depends only on
  it. Breaking changes land there first. See the
  [Package map](/pangolin/reference/package-map/).

## License & the Change Date

BSL 1.1: all use is permitted **except offering Pangolin Scale as a hosted/managed
orchestration service.** The **Change Date is four years from first publish**, at
which point the license converts to **Apache-2.0**. Self-hosting is also the
compliance model — regulated data never leaves your account. See
[Licensing & BSL](/pangolin/explanation/licensing-bsl/) and
[ADR-0017](/pangolin/explanation/decisions/0017-source-available-bsl/).
