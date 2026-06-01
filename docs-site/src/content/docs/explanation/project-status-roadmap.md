---
title: Project status & roadmap
description: What's shipped in V1, what's planned next (V1.1, additive), and what's left as a branch — plus the BSL posture and stability guarantees.
---

agora is **source-available** under the Business Source License 1.1. **V1 is
shipped** — the offload orchestrator runs unattended, escapes a reviewable patch
per task, and produces a verifiable audit bundle. Everything planned beyond V1 is
**additive**: the V1.1 layer is a strict superset of what V1 ships, so it accretes
without a refactor.

There are no dates. Items move from *Later* → *Next* → *Now* as the work is
pulled by a real use case, not on a schedule.

:::note
agora is **mechanism, not policy.** It ships enforcement points and primitives;
it does not own roles, sharing, scheduling policy, or who-can-do-what. That is by
design and shapes the whole roadmap.
:::

## Now — shipped in V1

The local-Docker acceptance path is proven live: safe fan-out under file-locks, a
per-edit patch artifact (`result_ref`), and a verifiable **tamper-detecting**
audit bundle.

- **`serve` driver** — long-running process; sole writer of the SQLite run-state,
  polls the submission inbox, runs the reconcile tick loop, exits cleanly on signal.
- **Submission transport** — clients write a Run spec to a storage prefix; `serve`
  ingests and publishes status/completion records. **No inbound networking** to the
  container; identical on local FS and S3.
- **Sandbox escape** — the worker captures the workspace diff, uploads it as a
  content-addressed artifact, and surfaces it as `result_ref`.
- **Retry / backoff** — per-item attempt counter, configurable `maxAttempts`,
  exponential backoff; exhausted items go `failed`, dependents `skipped`.
- **Operator surface** — CLI `agora orch serve | submit | status | watch | cancel
  | audit`; three client MCP tools (`agora_orchestrator_submit | _status |
  _watch`). `audit` is deliberately not on MCP. A CI allowlist check fails if any
  privileged/service method becomes MCP-reachable — see
  [The privilege boundary](/agora/explanation/privilege-boundary/).
- **Persistent run-state** — SQLite on the service's own volume.
- **The `default` queue** — concurrency configured at construction. Named queues
  remain a contract, not yet a feature.
- **Compliance & audit controls** — signed dispatch manifest, Merkle-rooted audit
  log with a pluggable `AuditAnchor` seam, actor identity on every operation, and
  `agora orch audit` evidence export. See
  [Audit & guarantee tiers](/agora/explanation/audit-guarantee-tiers/).
  **Encryption-at-rest on S3 writes is agora-set** — `S3StorageProvider` takes an
  `encryption` option (SSE-S3, or customer-managed SSE-KMS via
  `{ mode: 'aws:kms', kmsKeyId }`); unset inherits the bucket default (no-downgrade).
  Other at-rest layers (SQLite run-state volume, staged secrets) remain
  substrate-provided. The claim is **"compliance-ready," never "compliant" or
  "certified."**
- **Headline demo** — a single `submit` exercising locks + deps + concurrency +
  isolation + patch escape, producing a verifiable audit bundle. Walk it in
  [Your first offload run](/agora/tutorials/first-offload-run/).
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

### Known gap in V1

End-to-end **Fargate + S3 parity is operator-deferred.** Every production
component exists in code (`FargateProvider`, `S3StorageProvider`,
`AwsCredentialProvider`, and `S3ObjectLockAnchor` for the external-immutable audit
tier), but the maintainers have not run the full Fargate+S3 path end-to-end. Treat
[Deploy to Fargate + S3](/agora/how-to/deploy-fargate-s3/) as a first-run guide,
not a tested recipe — and note that no concrete `S3LockClient` adapter ships (the
interface is provided; you implement it).

## Next — V1.1 (additive, no refactor)

A strict superset of V1; nothing below changes what V1 ships.

- **`cron` trigger** — recurring scheduling via the existing `Trigger` seam.
  `serve` + manual `submit` already delivers *unattended* offload; `cron` adds
  *recurring*. **First item to pull into V1.1.**
- **Operationalize the `dev` pack** — the `dev.code-edit` / `dev.verify` shapes and
  the `PackRegistry` already exist in code (see "Now"), but aren't dispatchable yet:
  pin the real worker-image digest (currently a `PLACEHOLDER`) and enforce each
  shape's `outputSchema` via `.agora/output.json`.
- **Full typed output (enforcement)** — the worker **already writes**
  `.agora/output.json` (a fixed `{schemaVersion, patchRef, summary}` sentinel) and
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
- **Compliance deepening** — extend customer-managed encryption **beyond S3
  objects** (S3 SSE/SSE-KMS already ships; deferred: envelope-encrypted staged
  secrets + encrypted run-state), full role-based RBAC, automated retention/purge,
  SIEM/log-export, and a
  **Bedrock-backed `RuntimeAdapter`** (keeps the model call inside a customer's AWS
  BAA boundary). All additive via existing seams.
- **`WitnessAnchor` audit tier** — pushes the audit root to a cross-org witness
  (RFC 3161 TSA / transparency log); an additive third tier above
  `external-immutable`.

## Later — branches (pulled when a use case needs them)

No refactor required when pulled — that is what the architecture bought.

- Additional executors: `shell`, `batch-api`, `dag-plan`.
- Additional packs beyond `dev`.
- Predicate / signal / event triggers.
- Named queues beyond `default`; rate-limiting.
- `pause` / `resume`.
- An HTTP submission transport (V1 is storage-prefix polling only).
- The `Claim` core type + Mneme integration.

## Versioning & stability

- agora is **pre-1.0 (`0.x`)** — interfaces may change between minor versions
  until 1.0.
- `agora-core` is the **types-only contract**; every other package depends only on
  it. Breaking changes land there first. See the
  [Package map](/agora/reference/package-map/).

## License & the Change Date

BSL 1.1: all use is permitted **except offering agora as a hosted/managed
orchestration service.** The **Change Date is four years from first publish**, at
which point the license converts to **Apache-2.0**. Self-hosting is also the
compliance model — regulated data never leaves your account. See
[Licensing & BSL](/agora/explanation/licensing-bsl/) and
[ADR-0017](/agora/explanation/decisions/0017-source-available-bsl/).
