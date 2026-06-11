---
title: "Use case: regulated document drafting"
description: Batch-draft regulated documents — claims appeals, filings, reconciliations — with parallel sandboxed agents, and hand over a verifiable audit bundle of exactly what ran.
---

You build an agent product for a regulated vertical — healthcare, insurance,
legal, finance. The agent works. The deal stalls anyway, on two questions your
hosted stack can't answer: **where does it run** (their data can't leave) and
**can you prove what it did** (their auditor won't take a dashboard's word for
it). Pangolin Scale is the execution substrate that answers both: self-hosted,
sandboxed, and sealing a verifiable record of every run.

## What you get

The shipped demo for this use case is
[`examples/demo-claims-appeals`](https://github.com/quarrysystems/pangolin/tree/main/examples/demo-claims-appeals):
a batch of three denied insurance claims fans out to parallel agents that each
draft an appeal, self-verify their own work, and seal the evidence.

- **Safe fan-out** — three `claim-appeal` items run concurrently (concurrency 2),
  each under a per-output `resourceLock`, so parallel drafts never collide.
- **Patch escape** — each drafted appeal surfaces as a content-addressed
  `resultRef` (the workspace diff), never stored in the run-state database.
- **Self-verify, sealed with the patch** — each agent runs a shell check over its
  own edit (`appeals/*.md` exists and cites a policy section) before its patch
  escapes; the pass/fail is sealed into the dispatch manifest.
- **A verifiable audit bundle** — after all items are terminal, the run seals a
  hash-chained, Merkle-rooted log and the bundle report prints:

```text
=== Audit bundle ===
  intact:    true
  claim:     tamper-detecting
  anchorId:  local
  guarantee: detect
```

Forge one byte of the exported bundle and verification fails with a non-zero
exit code — that is the demo's closing beat.

## How it works

1. `plan.json` declares three `claim-appeal` items plus a `verify` gate that
   depends on all three. The orchestrator resolves dependencies, locks, and
   concurrency — see [How an offload run executes](/pangolin/explanation/how-offload-runs/).
2. Each item dispatches into an isolated Docker container. The agent reads one
   synthetic claim fixture (`claimId`, `denialReason`, `policySection`, …) and
   drafts `appeals/<claimId>.md` in its own workspace.
3. Before the patch escapes, the item's self-verify command runs inside the
   worker; its result is sealed into the manifest alongside the patch.
4. On completion the run seals its epoch: every lifecycle event is hash-chained,
   the chain is reduced to a Merkle root, and the root is signed and anchored —
   see [Audit & guarantee tiers](/pangolin/explanation/audit-guarantee-tiers/).
5. `pangolin verify` re-verifies the exported bundle — see
   [Export & verify an audit bundle](/pangolin/how-to/verify-audit-bundle/).

The claims domain is a reskin, not a special case: swap the fixtures and the
`claim-appeal` prompt to draft legal filings, reconciliations, or procurement
documents — the proof beats are identical.

## Run it yourself

Requires Node 20+, pnpm, Docker, and an Anthropic API key. The worker image is
not anonymously pullable, so build it locally first:

```sh
# from the repo root
pnpm install
docker build -f docker/pangolin-worker/Dockerfile -t ghcr.io/quarrysystems/pangolin-worker:latest .
cp .env.example .env       # then set ANTHROPIC_API_KEY in .env
pnpm --filter demo-claims-appeals-example start:env
```

No Docker or API key handy? The CI smoke test drives the same plan through a
fake executor and asserts the bundle verifies:

```sh
pnpm --filter demo-claims-appeals-example test
```

:::caution[Shipped today vs. on the roadmap]
- The demo's default anchor is `LocalAnchor`, so its honest claim is
  **tamper-detecting** — the root lives in the same store as the log. The
  **tamper-evident** claim requires the `external-immutable` tier
  (`S3ObjectLockAnchor`); see
  [Audit & guarantee tiers](/pangolin/explanation/audit-guarantee-tiers/).
- The claim fixtures are **synthetic** — no real PHI anywhere in the example.
- The canonical run is the single-process driver shown above. The multi-process
  CLI flow (`pangolin orch serve` / `submit` / `audit` as separate processes)
  is not yet runnable for this example — it needs a registration/deploy step
  that has not shipped.
- Pangolin Scale's vocabulary is **"compliance-ready," never "compliant" or
  "certified."** The audit trail proves what ran and what it produced — not
  that the output is correct.
:::

## Next steps

- [Your first offload run](/pangolin/tutorials/first-offload-run/) — the orchestrator tutorial (different example, same mechanics).
- [Export & verify an audit bundle](/pangolin/how-to/verify-audit-bundle/) — produce and re-verify the evidence.
- [Commercial & pilots](/pangolin/commercial/) — white-glove pilot for your regulated deal.
