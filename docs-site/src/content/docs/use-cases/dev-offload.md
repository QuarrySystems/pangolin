---
title: "Use case: dev offload"
description: Fan codebase maintenance out to parallel sandboxed agents and get back reviewable patches — with an audit trail of exactly what ran while you weren't watching.
---

Running coding agents locally pegs your CPU and ties the work to your laptop's
uptime; running them unattended means trusting output you didn't watch get
made. Pangolin Scale offloads the work to isolated containers, fans it out
safely in parallel, and hands back **a reviewable patch per task** — plus a
sealed record of what ran, so "unattended" stops meaning "unaccountable."

## What you get

The acceptance demo for this use case is
[`examples/offload-fanout`](https://github.com/quarrysystems/pangolin/tree/main/examples/offload-fanout):
three independent code edits fan out across Docker workers, then a verify gate
checks the result.

- **Safe parallelism** — each `code-edit` item holds a per-file `resourceLock`;
  two items that touch the same file serialize automatically instead of racing.
- **Reviewable patches** — each worker's output is its workspace diff, escaped
  as a content-addressed `resultRef`. You review the patch before anything
  touches your repo; nothing auto-merges.
- **Retry / backoff** — an engine-wide behavior (not specific to this demo):
  failed items retry with exponential backoff up to `maxAttempts`; exhausted
  items go `failed` and their dependents are skipped, all of it recorded in
  the audit log.
- **The sealed record** — the run ends with the same verifiable audit bundle as
  every other domain:

```text
=== Audit bundle ===
  intact:    true
  claim:     tamper-detecting
  anchorId:  local
  guarantee: detect
```

## How it works

1. `plan.json` declares three `code-edit` items plus a `verify` gate that
   depends on all three; each item names the file it owns as a
   `resourceLock`. The orchestrator resolves dependencies, locks, and
   concurrency — see
   [How an offload run executes](/pangolin/explanation/how-offload-runs/).
2. Each item dispatches into an isolated Docker container, where the agent
   edits its file in a private workspace — see
   [Sandboxing AI agents](/pangolin/explanation/sandboxing-ai-agents/).
3. The workspace diff escapes as a content-addressed artifact and surfaces as
   the item's `resultRef`; the run-state database only ever holds references.
4. After all items are terminal the run seals its epoch and the audit bundle
   is assembled and verified — see
   [Audit & guarantee tiers](/pangolin/explanation/audit-guarantee-tiers/).

## Gated circle-back: when review fails, the run fixes itself — on the record

[`examples/pattern-dogfood`](https://github.com/quarrysystems/pangolin/tree/main/examples/pattern-dogfood)
shows the `pipeline` pattern's spawn-fix gate. When a `review` gate completes
**done-but-red** (its verify check failed), the pattern appends a fix item, a
re-review, and a re-run of the downstream task via the audited `extendRun`
seam. The original red review and the skipped downstream item are preserved as
sealed history — the run is never rewound, only extended with a forward arc.
Every spawn writes a `run.extended` audit entry naming which gate fired, with
the pattern layer as the recorded actor (`actor=pattern:default`), and
provenance closure is checked across the grown graph. See
[Execution patterns](/pangolin/explanation/execution-patterns/) and
[Typed-product handoff](/pangolin/explanation/typed-product-handoff/).

## Run it yourself

The live fan-out (real Docker workers, real agents) — requires Node 20+, pnpm,
Docker, and an Anthropic API key, with the worker image built locally first:

```sh
# from the repo root
pnpm install
docker build -f docker/pangolin-worker/Dockerfile -t ghcr.io/quarrysystems/pangolin-worker:latest .
cp .env.example .env       # then set ANTHROPIC_API_KEY in .env
pnpm --filter offload-fanout-example start:env
```

The gated circle-back demo runs offline — no Docker, no API key:

```sh
pnpm --filter pattern-dogfood-example start
```

:::caution[Shipped today vs. on the roadmap]
- `offload-fanout`'s live path dispatches real agents in real containers.
  `pattern-dogfood` runs a **deterministic in-memory fake executor** — no
  containers, no LLM — so it proves the engine's circle-back, audit, and
  provenance semantics, not live agent behavior.
- The default audit tier in both is **tamper-detecting** (`LocalAnchor`). The
  stronger **tamper-evident** claim requires the `external-immutable` tier
  (`S3ObjectLockAnchor`); see
  [Audit & guarantee tiers](/pangolin/explanation/audit-guarantee-tiers/).
- The vocabulary is **"compliance-ready," never "compliant" or "certified"** —
  the audit trail proves what ran, not that the output is correct. For the
  evidence/auditor story, see
  [Compliance evidence](/pangolin/use-cases/compliance-evidence/).
:::

## Next steps

- [Your first offload run](/pangolin/tutorials/first-offload-run/) — submit your own plan.
- [How an offload run executes](/pangolin/explanation/how-offload-runs/) — queues, deps, locks, audit.
- [Sandboxing AI agents](/pangolin/explanation/sandboxing-ai-agents/) — the isolation model.
