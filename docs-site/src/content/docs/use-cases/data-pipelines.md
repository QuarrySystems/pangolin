---
title: "Use case: data pipelines"
description: Run non-LLM batch data jobs on the same engine — typed handoffs, runtime fan-out, and the identical provenance-checked audit chain. Fully offline demo.
---

If your agent runs deserve provable execution, so do the batch jobs around
them — and nobody wants a second orchestrator with a second audit story.
Pangolin Scale's engine is domain-general: the same queues, dependency
resolution, typed handoffs, and sealed audit chain that run coding agents also
run plain data pipelines, with **zero engine changes**.

## What you get

The proof is
[`examples/data-mapreduce`](https://github.com/quarrysystems/pangolin/tree/main/examples/data-mapreduce)
— a map-reduce over CSV data that is **fully offline**: no Docker, no API key,
no network.

- **Runtime fan-out** — two items are submitted (`seed`, `split`); the
  `mapReduce` pattern spawns one map item per data partition at runtime, plus
  a reduce. The graph grows from 2 to 5 items, every spawn audited.
- **Typed handoffs** — each stage consumes its upstream's output via `needs`,
  materialized into the worker at `inputs/<key>` and sealed into the manifest
  as content-addressed `inputRefs`.
- **Per-block evidence** — each item's pipeline records `blocks[]` entries
  (script and capture steps with status), sealed with the run.
- **The same provenance-checked bundle** — verification confirms every
  consumed input ref is accounted for by a sealed producer (output
  abbreviated):

```text
=== verifyBundle report ===
  intact:           true
  checks.handoff:   {"ok":true,"detail":"5 input refs accounted for"}

=== data-mapreduce OK — graph grew at runtime (5 items); aggregate sum=100; provenance intact ===
```

## How it works

1. `seed` writes a small CSV; `split` groups it by key and writes one file per
   group. The `mapReduce` config on `split` makes the engine spawn one
   `map-<key>` item per output file.
2. Each map item sums its partition; `reduce` receives all map results and
   totals them (expected: 100).
3. Each item runs a declared block pipeline (script and capture steps), typed
   against the `data` pack's shapes (`data.split` / `data.transform` /
   `data.aggregate`) — the second domain pack on the unchanged engine. See
   [Execution patterns](/pangolin/explanation/execution-patterns/) and
   [Typed-product handoff](/pangolin/explanation/typed-product-handoff/).

## Run it yourself

```sh
pnpm install
pnpm --filter data-mapreduce-example start     # exits 0 on success
```

:::caution[What this example proves — and what it deliberately skips]
This demo runs on `InprocWorkerExecutor`, a **test fixture that executes
pipelines in-process** — no container sandbox, no network firewall, no
filesystem isolation. It exists so the demo is instant and dependency-free,
and it must never be used in production. Production dispatches go through
`DispatchExecutor` into isolated compute (local Docker or Fargate). What the
example proves is that the **engine, patterns, and audit chain are
domain-general** — not that data jobs are sandboxed by this demo.
:::

## Next steps

- [How an offload run executes](/pangolin/explanation/how-offload-runs/) — the engine underneath.
- [Typed-product handoff](/pangolin/explanation/typed-product-handoff/) — `needs`, `inputRefs`, provenance closure.
- [Your first offload run](/pangolin/tutorials/first-offload-run/) — the same engine with live workers.
