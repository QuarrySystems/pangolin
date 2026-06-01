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

The local-Docker acceptance path is proven live: safe fan-out under file-locks,
a per-edit patch artifact (`result_ref`), and a verifiable **tamper-detecting**
audit bundle. Delivered across five waves (PRs #18, #19, #21, #22, #23; V1 marked
shipped in #24).

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
  actor identity on every operation, `agora orch audit` evidence export, and
  encryption-at-rest by default. The claim is **"compliance-ready," never
  "compliant" or "certified."**
- **Headline demo** — [`examples/offload-fanout`](examples/offload-fanout/):
  one `submit` exercising locks + deps + concurrency + isolation + patch escape,
  producing a verifiable audit bundle.
- **BSL packaging** — root `LICENSE`, `BUSL-1.1` in every package, `LICENSING.md`.

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

- **`cron` trigger** — recurring scheduling via the existing `Trigger` seam.
  `serve` + manual `submit` already delivers *unattended* offload (submit once,
  walk away); `cron` adds *recurring*. **This is the first item to pull into
  V1.1.**
- **Full typed output** — `outputSchema` validation, `output` data products,
  `intents`, `signals` (the complete `output.json` contract).
- **The autonomous-PR layer** — `Intent` / `IntentInterpreter`, the `dev.open-pr`
  interpreter, the auto-merge-test-only / human-approve policy, and the CLI
  `approve` verb. This is the "lean-runner cut" deferred from V1.
- **The `dev` pack** — `code-edit` / `verify` subagent shapes. (V1 names plain
  registered subagents in `WorkItem.inputs`.)
- **Cost accounting / budget enforcement.**
- **Effect-tier enforcement** — the vocabulary already exists as a typed property;
  V1.1 makes policy read it.
- **`Authorizer` seam** — an implementor-filled authorization policy. agora ships
  the chokepoint (the operations API) and identity primitives (`actor`, the
  client/service privilege split); it never owns roles. V1 is single-operator
  ("whoever launched").
- **Compliance deepening** — customer-managed keys (BYOK/KMS), full role-based
  RBAC, automated retention/purge policy, SIEM/log-export integrations, and a
  **Bedrock-backed `RuntimeAdapter`** (keeps the model call inside a customer's
  AWS BAA boundary). All additive via existing seams. The SOC2 audit / HIPAA risk
  assessment themselves are organizational process, not software.
- **`WitnessAnchor` audit tier** — pushes the audit root to a cross-org witness
  (RFC 3161 TSA / transparency log) for customers who won't trust even their own
  WORM admin. Additive third tier above `external-immutable`.

---

## Later — branches (pulled when a real use case needs them)

These require **no refactor** when pulled — that is what the architecture bought.

- Additional executors: `shell`, `batch-api`, `dag-plan`.
- Additional packs beyond `dev`.
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
