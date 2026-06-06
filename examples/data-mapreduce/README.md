# data-mapreduce — offline data-domain demo

> **ISOLATION CAVEAT (READ THIS FIRST)**
>
> This example uses **`InprocWorkerExecutor`** — a TEST FIXTURE from
> `packages/agora-orchestrator/test/fixtures/inproc-worker-executor.ts`.
>
> InprocWorkerExecutor runs worker pipelines **IN-PROCESS**. There is no
> container sandbox, no network firewall, no filesystem isolation. Scripts
> run directly in the Node.js process that drives the orchestrator.
>
> This executor is a **demo/test bridge only**. It MUST NEVER be used in
> production. Production dispatches use `DispatchExecutor`, which submits
> work to an isolated compute layer (Fargate, local-docker, etc.).

## What this proves

Second-domain forcing function: the **map-reduce pattern** works for data
pipelines with zero engine changes. The entire orchestration engine
(pattern, needs-resolver, audit chain, verifyBundle) is reused unchanged
from the dev-domain dogfood example.

Reference spec: `docs/superpowers/specs/2026-05-28-*.md` (orchestrator design).

## How it works

### Run shape (plan.json)

```
seed ──[outputs/data.csv]──▶ split ──[mapReduce config]
                                         │
                       ┌─────────────────┤
                       ▼                 ▼
               map-a.csv            map-b.csv
                       │                 │
                       └────────┬────────┘
                                ▼
                             reduce
```

Two items are **submitted**; three more are **spawned at runtime** by the
`mapReduce` pattern:

| Item       | Role      | Pipeline registered |
|-----------|-----------|---------------------|
| `seed`    | submitted | `data-mapreduce.seed` |
| `split`   | submitted | `data-mapreduce.split` |
| `map-a.csv` | spawned  | `data-mapreduce.transform` |
| `map-b.csv` | spawned  | `data-mapreduce.transform` |
| `reduce`  | spawned   | `data-mapreduce.aggregate` |

### Data flow

1. **seed** writes a small CSV to `outputs/data.csv`:
   ```
   group,value
   a,10
   a,20
   b,30
   b,40
   ```

2. **split** receives the CSV at `inputs/input` (via `needs: { input: { from: seed, ... } }`),
   groups rows by the first column, writes `outputs/a.csv` and `outputs/b.csv`.
   The `mapReduce` config on this item causes the engine to spawn one
   `map-<key>` item per output file.

3. **map-a.csv / map-b.csv** each receive one group's CSV at `inputs/input`,
   sum the value column, and write the sum to `outputs/result`.

4. **reduce** receives all map results at `inputs/part-a.csv` and
   `inputs/part-b.csv` (via the pattern's `keyPrefix` naming), totals them,
   and writes the grand total to `outputs/result`.

Expected result: **100** (a=30, b=70).

### plan.json placeholder convention

`plan.json` contains the structural skeleton of the run. Pipeline and
subagent refs are content hashes that are only known after runtime
registration. Those slots are marked `"<filled-at-runtime>"`:

```json
{ "pipeline": "<filled-at-runtime>" }
```

`src/index.ts` registers all four pipelines + one stub subagent via
`registerSubagent` / `registerPipeline` (real client APIs, shared
`LocalStorageProvider`), then fills the placeholders with the returned
pinned URIs before calling `orch.submitRun(plan)`.

### Provenance closure

Every dispatch produces a manifest blob (stored at the dispatch record URI
in the shared `LocalStorageProvider`). `assembleBundle` + `verifyBundle`
walk the audit chain and verify that every input ref is accounted for in
a sealed manifest — the same provenance check used in production.

## Running offline

```bash
pnpm install                                      # from repo root
pnpm --filter data-mapreduce-example start        # exits 0 on success
pnpm --filter data-mapreduce-example typecheck    # TypeScript static check
```

No Docker, no API key, no network. All storage is in a temporary directory
that is deleted on exit.

## Expected output (abbreviated)

```
=== Grown graph (2 submitted → seed+split+maps+reduce) ===
  map-a.csv: done
  map-b.csv: done
  reduce: done
  seed: done
  split: done
  Total items: 5

=== Aggregate numeric result (reduce outputRef) ===
  reduce result: 100

=== blocks[] evidence sample (sentinel of map-a.csv) ===
  sentinel.blocks (2 entries):
    [0] kind=script status=ok
    [1] kind=capture status=ok

=== verifyBundle report ===
  intact:           true
  checks.handoff:   {"ok":true,"detail":"5 input refs accounted for"}

=== data-mapreduce OK — graph grew at runtime (5 items); aggregate sum=100; provenance intact ===
```
