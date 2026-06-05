# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
All packages are versioned in lockstep; this file is the changelog for the whole
workspace. See [RELEASING.md](./RELEASING.md) for how a release is cut.

## [Unreleased]

### Added

- **Typed-product handoff (Wave A–C).** Dependent DAGs now hand products node-to-node
  by content-addressed ref: Wave A (#39) added the `outputs/` / `outputRefs` producer
  seam; Wave B (#40) added the `needs` consumer wiring (auto-unioned into `depends_on`
  at submit-normalization, resolved at fire time into `inputs.inputRefs`) plus
  `buildManifest` sealing of those refs; Wave C (this PR) closes the provenance loop —
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
  does not change the dispatch outcome. The patch is captured *before* verify so
  build artifacts never pollute it; registered secrets are redacted from the
  report; a new `verify.ran` worker event is emitted. Set it via
  `client.subagent.register({ verify: { command, timeout } })`.

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

[Unreleased]: https://github.com/QuarrySystems/agora/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/QuarrySystems/agora/releases/tag/v0.1.0
