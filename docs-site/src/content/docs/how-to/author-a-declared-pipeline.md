---
title: Author & register a declared pipeline
description: Write a PipelineSpec from the shipped block kinds, validate it offline, register it as a pinned immutable version, and pin it on a work item via inputs.pipeline.
---

By default every dispatch runs the worker's built-in pipeline
(`agent → capture(patch) → script(verify) → capture(outputs)`). A **declared
pipeline** replaces that default with a block sequence you author — the
mechanism behind non-agent work like the
[data pipelines use case](/pangolin/use-cases/data-pipelines/). This guide
takes a spec from authoring to sealed evidence. For what each block *does* at
runtime, see
[Dispatch lifecycle → The block-pipeline runner](/pangolin/reference/dispatch-lifecycle/#the-block-pipeline-runner).

:::note[The authoring ceiling today]
Pipelines are assembled from the three shipped block kinds — `agent`,
`script`, `capture`. User-supplied custom code blocks and adapter blocks are
explicitly deferred on the
[roadmap](/pangolin/explanation/project-status-roadmap/); if you need a
behavior the shipped kinds can't express, that is a roadmap conversation, not
a spec trick.
:::

## 1. Write the spec

A `PipelineSpec` (from `@quarry-systems/pangolin-core`) is data only — what the
pipeline *is*, not how it runs:

```typescript
interface PipelineSpec {
  schemaVersion: 1;                        // literal 1
  id: string;                              // '<pack>.<name>', e.g. 'data.transform'
  blocks: BlockSpec[];                     // ordered, non-empty; 'seal' must NOT appear
  outputEdgeType?: string;                 // edge-type tag (matches SubagentShape.outputEdgeType)
  inputEdgeTypes?: Record<string, string>; // per-input edge-type tags
}

type BlockSpec =
  | { kind: 'agent' }                      // run the registered subagent's runtime adapter
  | { kind: 'script';                      // shell command, time-bounded + output-capped
      command: string;                     //   non-empty
      timeoutSeconds?: number;             //   positive; default 600
      lens?: 'gate' | 'verify' }           //   gate (default): non-zero exit fails the dispatch
                                           //   verify: report-only, never fails it
  | { kind: 'capture';
      what: 'patch' | 'outputs' };         // workspace diff, or content-address outputs/ files
```

Two rules trip authors most often:

- **`seal` is never authored.** The runner always auto-appends it as the
  terminal step; a literal `seal` block is rejected by validation.
- **`id` must be pack-scoped**: exactly one dot, lowercase alphanumeric and
  hyphens on both sides (`data.transform`, not `transform` or
  `Data.Transform`).

A small worked spec — transform a staged input with a script, then capture
what it wrote:

```json
{
  "schemaVersion": 1,
  "id": "data.transform",
  "blocks": [
    { "kind": "script", "command": "node transform.js", "timeoutSeconds": 120 },
    { "kind": "capture", "what": "outputs" }
  ],
  "outputEdgeType": "dataset-ref"
}
```

## 2. Validate it offline

```sh
pangolin pipeline validate spec.json
```

This is **storage-free** — no `pangolin.config`, no client, no network. It runs
the same `validatePipelineSpec` check used by `register` and by the worker
itself, and it is **collect-all**: every error prints at once (unknown kinds,
a reserved `seal` block, a malformed id, an empty `blocks`, bad script/capture
parameters, empty edge-type tags). Exit code is `1` on an invalid spec, `OK`
on a valid one — safe to gate CI on.

## 3. Register it

Via the CLI:

```sh
pangolin pipeline register spec.json    # prints the pinned ref to use
```

or programmatically:

```typescript
const ref = await client.pipeline.register(spec);
// { id: 'data.transform', registeredAt: '…', contentHash: 'sha256:…' }
```

Registration content-addresses the spec over its canonical (sorted-key) JSON
and stores it as a **pinned immutable version**. Re-registering the identical
spec is idempotent — same hash, no duplicate write. A *different* spec under
the same `id` produces a new pinned version; both coexist immutably, so a
running plan can never have its pipeline edited out from under it.

## 4. Pin it on a work item

Set the reserved `inputs.pipeline` key on the work item to the registered
ref. In a `plan.json`:

```json
{
  "id": "transform",
  "executor": "dispatch",
  "inputs": {
    "subagent": "data-noop",
    "pipeline": "<the ref printed by register>"
  },
  "depends_on": [],
  "resourceLocks": []
}
```

At fire time the pinned spec rides the existing bundle channel, and the worker
**re-validates it after fetching** — a parse or validation failure routes
through the established `integrity-failed` path, like any malformed bundle.
The agent never runs against a spec that doesn't check out.

## 5. Read the evidence

A declared pipeline writes per-block evidence into the output sentinel as
`blocks[]` — kind, ordinal, status, exit code, and duration per block — and
the pipeline ref itself is sealed into the dispatch manifest as
`pipelineRef`. "This exact pipeline ran — every block, command, and lens" is
provable from the audit bundle, on the same footing as the patch and input
refs. See
[Export & verify an audit bundle](/pangolin/how-to/verify-audit-bundle/).

## See also

- [Assemble a pattern-driven plan](/pangolin/how-to/assemble-a-pattern-plan/) — pipelines often pair with the map-reduce pattern (one declared pipeline per stage).
- [`pangolin pipeline` CLI reference](/pangolin/reference/cli/#pangolin-pipeline) — register / validate / list semantics.
- [`client.pipeline` API](/pangolin/reference/pangolin-client-api/#clientpipeline) — the programmatic surface.
- [`examples/data-mapreduce`](https://github.com/quarrysystems/pangolin/tree/main/examples/data-mapreduce) — four declared pipelines driving a fully offline run.
