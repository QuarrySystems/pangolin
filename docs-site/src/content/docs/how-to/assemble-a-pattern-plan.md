---
title: Assemble a pattern-driven plan
description: Bind an execution pattern to a queue, then author the item payloads that drive it — inputs.mapReduce for runtime fan-out and inputs.gate for the self-correcting circle-back.
---

A static `plan.json` fully specifies its DAG at submit time. A
**pattern-driven plan** grows at runtime: the map-reduce pattern spawns one
map item per data partition, and the pipeline pattern spawns a fix lineage
when a gate goes red. This guide assembles both. For the model underneath —
the `Pattern` contract, `extendRun`, and the forward-arc-never-rewind
invariant — read [Execution patterns](/pangolin/explanation/execution-patterns/)
first.

## 1. Bind the pattern to a queue

Patterns are bound where the orchestrator is constructed — for the CLI
`serve` path, that is your [`pangolin.config.mjs`](/pangolin/reference/config/):

```js
import { PangolinOrchestrator } from '@quarry-systems/pangolin-orchestrator';
import { mapReduce, pipeline } from '@quarry-systems/pangolin-orchestrator/patterns';

const orchestrator = new PangolinOrchestrator({
  // …store, executors, transport wiring as in the config reference…
  queues: {
    default: { concurrency: 2 },                   // no pattern → static DAG
    batch:   { concurrency: 4, pattern: mapReduce },
    ci:      { concurrency: 2, pattern: pipeline },
  },
});
```

There is no string-keyed pattern selector and no config file syntax — the
binding is the `pattern` field on `QueueConfig`, and per-pattern configuration
travels **on the items themselves** via two reserved `inputs` keys, below. A
plan submitted to a queue with no pattern treats those keys as inert inputs.

## 2. Assemble a map-reduce plan

Only the **splitter** item is pattern-aware: it carries a `MapReduceConfig` on
the reserved `inputs.mapReduce` key. Submit two items; the pattern spawns the
rest at runtime.

```typescript
interface MapReduceConfig {
  map:    SpawnTemplate & { needsKey?: string; outputPath?: string }; // defaults: 'input', 'result'
  reduce: SpawnTemplate & { keyPrefix?: string };                     // default: 'part'
}

interface SpawnTemplate {              // a subset of WorkItem
  executor: string;
  inputs: Record<string, unknown>;
  subagentShape?: string;
  resourceLocks?: string[];
}
```

The splitter from
[`examples/data-mapreduce/plan.json`](https://github.com/quarrysystems/pangolin/tree/main/examples/data-mapreduce)
(refs abbreviated — the example fills them from runtime registration):

```json
{
  "id": "split",
  "executor": "dispatch",
  "inputs": {
    "subagent": "<registered ref>",
    "pipeline": "<registered ref>",
    "mapReduce": {
      "map":    { "executor": "dispatch", "inputs": { "subagent": "<ref>", "pipeline": "<ref>" } },
      "reduce": { "executor": "dispatch", "inputs": { "subagent": "<ref>", "pipeline": "<ref>" } }
    }
  },
  "depends_on": [],
  "resourceLocks": [],
  "needs": { "input": { "from": "seed", "select": { "kind": "output", "path": "data.csv" } } }
}
```

What happens at runtime:

1. When the splitter is `done`, the pattern reads its `outputRefs` and spawns
   one **`map-<key>`** item per output key, each built from the `map`
   template, with the partition bound to the map item's `needs` under
   `needsKey` (default `input`).
2. When every spawned map is `done`, the pattern spawns a single **`reduce`**
   item from the `reduce` template, whose `needs` bind each map's output
   (named `<keyPrefix>-<key>`, default prefix `part`).
3. Spawn ids are deterministic (`map-<outputKey>`, literal `reduce`), so
   crash-and-replay reproduces the same graph and `extendRun`'s id-skip
   absorbs duplicates.

A run may carry **at most one splitter** — `plan()` validates this at submit,
before anything is stored.

## 3. Assemble a gated pipeline plan

On a `pipeline`-bound queue, `plan()` first chains your items (each item
without explicit `depends_on` depends on its predecessor). A **gate item**
carries a `GateConfig` on the reserved `inputs.gate` key:

```typescript
interface GateConfig {
  onRed: 'advance' | 'spawn-fix';
  subject: string;              // itemId whose product is being gated
  fixTemplate?: SpawnTemplate;  // required for spawn-fix to actually spawn
  maxFixAttempts?: number;      // default 1
}
```

The gate from
[`examples/pattern-dogfood/plan.json`](https://github.com/quarrysystems/pangolin/tree/main/examples/pattern-dogfood):

```json
{
  "id": "review",
  "executor": "dispatch",
  "inputs": {
    "gate": {
      "onRed": "spawn-fix",
      "subject": "implement",
      "fixTemplate": { "executor": "dispatch", "inputs": {} }
    }
  },
  "depends_on": [],
  "resourceLocks": []
}
```

"Red" means the gate `failed`, **or** completed `done` with
`verify.passed === false` (the self-verify contract). On a red gate with
`onRed: 'spawn-fix'`, the pattern appends a deterministic lineage — the fix
item (`review-fix-1`, with `needs.work` bound to the subject's patch and
`needs.findings` bound to the gate's findings output when present), a gate
copy (`review~2`) re-evaluating after the fix, and copies of any descendants
that were skip-cascaded. The red gate and its skipped descendants stay in the
run as sealed history. A green gate spawns nothing — downstream items advance
through the normal engine path.

Respawn stops when `maxFixAttempts` is exceeded, when no `fixTemplate` is
configured, or when any lineage member was `cancelled`.

## 4. Validate, submit, watch, audit

```sh
pangolin orch validate plan.json     # static wiring check, ahead of submit
pangolin orch submit plan.json --queue batch
pangolin orch watch <run-id>         # spawned items appear live as the graph grows
pangolin orch audit <run-id>         # run.extended entries record every spawn batch
```

Malformed pattern config (a second splitter, a broken template) is rejected at
submit time by `pattern.plan()` — before the store is touched — so a bad plan
never burns a worker dispatch. Every runtime spawn flows through the audited
`extendRun` seam and lands in the bundle as a `run.extended` entry whose
`actor` is `pattern:<queue>`; `pangolin verify`'s provenance-closure check covers
the grown graph exactly as it covers a static one.

## See also

- [Execution patterns](/pangolin/explanation/execution-patterns/) — the contract and invariants these payloads drive.
- [plan.json schema → pattern payloads](/pangolin/reference/plan-json/#pattern-payloads-inputsgate-and-inputsmapreduce) — the field reference.
- [Author & register a declared pipeline](/pangolin/how-to/author-a-declared-pipeline/) — the per-stage pipelines map-reduce items typically pin.
- [`examples/pattern-mapreduce`](https://github.com/quarrysystems/pangolin/tree/main/examples/pattern-mapreduce) and [`examples/pattern-dogfood`](https://github.com/quarrysystems/pangolin/tree/main/examples/pattern-dogfood) — both runnable offline, no Docker or API key.
