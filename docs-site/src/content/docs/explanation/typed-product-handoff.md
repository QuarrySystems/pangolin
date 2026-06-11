---
title: Typed-product handoff
description: How a downstream task consumes an upstream task's output by content-addressed reference — the `needs` declaration, submit-time DAG validation, worker-side input materialization, and the provenance-closure check `pangolin verify` enforces.
---

A plan is a DAG, but the engine described in
[how an offload run executes](/pangolin/explanation/how-offload-runs/) only schedules
*when* an item runs — it does not move bytes between items. **Typed-product
handoff** is the seam that does: a downstream task declares what it consumes and
which upstream task produces it, and the orchestrator wires the
content-addressed output of the producer to the input directory of the consumer
before the agent starts. The dev case is "B applies A's patch," but the same
seam carries any artifact a worker can write — patches today, structured JSON or
binary blobs tomorrow — without a new code path.

This page explains the mechanic end-to-end: what the declaration looks like,
what the orchestrator validates, what the worker materializes, and what
`pangolin verify` proves once the run is sealed.

## What "typed-product handoff" means

A handoff is **typed** because each upstream task declares the *kinds* of
products it can produce (e.g. `patch`), and each downstream `needs` entry
selects against that kind — not against a file path, and not against opaque
stdout. It is a **product** because what crosses the seam is the immutable,
content-addressed output of a completed task — for `kind: "patch"`, the
workspace-diff patch the producer escaped; for `kind: "output"`, a named file
the producer wrote to `outputs/` — uploaded to the `StorageProvider` and named
by its hash. And it
is a **handoff** because the consumer never reaches into the producer's
workspace — the orchestrator resolves the ref, hands the bytes to the consumer's
sandbox, and records the edge in the audit evidence.

The result is that consumers stay sandbox-pure (no shared filesystem, no peek
at the producer's intermediate state) and the data path stays
provider-agnostic: a `LocalStorageProvider` hands over a file on disk and an
S3-backed storage provider hands over an object — the worker sees the same
materialized bytes either way.

## The `needs` declaration and whole-DAG validation

A consumer item declares its inputs in `needs`, a map keyed by the **input
name** the worker will materialize under `inputs/`:

```json
{
  "id": "apply-patch",
  "executor": "claude-code",
  "needs": {
    "patch": { "from": "edit-a", "select": { "kind": "patch" } }
  }
}
```

Two things are happening at once. First, `from` names the upstream WorkItem id
— so the engine can derive the `depends_on` edge from `apply-patch` to
`edit-a` automatically, without the author also hand-writing `depends_on:
["edit-a"]`. Second, `select.kind` names the *product kind* the consumer wants
— `patch` selects the producer's escaped workspace-diff patch; `output` (with
a `path`) selects a named entry from the producer's `outputs/` channel.

Validation runs at **submit time**, against the whole DAG, before a single
worker fires:

- Every `from` must resolve to a WorkItem in the same run.
- The induced edges, together with any explicit `depends_on`, must remain
  acyclic.
- When both producer and consumer declare typed shapes, the edge's
  product-type tags must be compatible — a mismatch is rejected with an error
  naming the edge. (A `select` the producer cannot furnish at all is caught at
  fire time, before the worker dispatches.)

A failure at this phase rejects the submission with a structured error — the
same path as any other plan-shape violation — so a malformed handoff never
reaches the tick loop and never burns a worker dispatch. Operators reading
`pangolin orch validate plan.json` get the same verdict ahead of submit.

## What the worker does

At fire time, the orchestrator resolves each `needs` entry to the upstream
task's content-addressed product ref and passes the resolved refs to the
executor as part of the signed dispatch manifest. From the worker's point of
view, two things change relative to a no-handoff dispatch:

- **Inputs are pre-staged.** Before the agent runs, the worker fetches each
  input ref through the `StorageProvider`, verifies the content hash matches
  the ref, and writes the bytes into the workspace at exactly `inputs/<key>` —
  for the declaration above, `inputs/patch`. The agent sees a normal file in a
  normal directory; it does not know or care that the bytes came from another
  task.
- **Outputs are captured by ref.** Anything the agent writes under `outputs/`
  is uploaded to the `StorageProvider` on success, hashed, and recorded as a
  content-addressed `outputRef` on the WorkItem record. This is what makes
  the output of *this* task eligible to be the input of a *next* task in
  another run, or — within the same run — to be selected by a downstream
  `needs` entry.

Both the consumed `inputRefs` and the produced `outputRefs` are sealed into the
dispatch manifest and into the audit evidence for the item, alongside the
existing `result_ref` (the workspace-diff patch escape described in
[how an offload run executes](/pangolin/explanation/how-offload-runs/)). Nothing
about the patch escape changes — it is the workspace diff, captured the same
way as before; `outputRefs` is the separate, *explicit* product channel.

## Provenance closure and the `handoff` check row

`pangolin verify` already proves four things about a sealed audit bundle — the
chain is intact, the merkle root matches, signatures verify, and the external
anchor (S3 Object Lock) matches the local epoch. Typed-product handoff adds a
fifth:

> **Provenance closure.** Every `inputRef` consumed by any item in the run must
> be a sealed product — the `resultRef` patch or an `outputRefs` value — of a
> `done` item in the **same run**.

This is what makes the run self-contained as evidence. An auditor handed the
bundle does not need to trust the storage layer or the orchestrator's word for
what flowed from where: every consumed byte is traceable, by content hash, to
a specific sealed upstream task in the same bundle. A reference to anything
outside the run — a manually staged file, a leftover from a previous run, a
ref the orchestrator could not produce — fails closure and fails verify.

In the `pangolin verify` output the new check appears as a fifth row alongside
the existing four:

```
✓ chain        12 entries, hash-linked, no gaps
✓ root         merkle = anchored root
✓ signature    true
✓ anchor       local  (detect)
✓ handoff      1 input ref accounted for
```

Reading the `handoff` row:

- **OK** with a count means every consumed input was matched to a producing
  item in the same run. The count is informational — it tells you how much
  cross-item data actually moved.
- **FAIL** names the offending consumer item, the input key, and the
  unresolved ref. The usual cause is a bundle from an interrupted run where a
  producer never reached `done` — closure is intentionally strict, so a
  partial run cannot present itself as a complete one.
- A run with no `needs` declarations passes `handoff` trivially (zero refs to
  close).

The check is local to the bundle — it does not re-fetch any bytes from
storage. It is a structural proof over the sealed evidence, on the same
footing as the chain and root checks.

## Try it: `examples/handoff-dag/`

The minimal worked example lives at
[`examples/handoff-dag/`](https://github.com/quarrysystems/pangolin/tree/main/examples/handoff-dag/).
It is a two-task plan: `edit-a` runs a small editor agent whose workspace edit
escapes as its content-addressed patch product, and `apply-patch` binds that
product via `needs` — a setup script applies it with `git apply inputs/patch`
before the agent runs. The example ends by re-verifying the assembled audit
bundle, printing the `handoff` check so you can see provenance closure in real
output before going back to your own plans.

## See also

- [How an offload run executes](/pangolin/explanation/how-offload-runs/) — where
  `needs` slots into the tick loop and the `depends_on` resolver.
- [plan.json schema](/pangolin/reference/plan-json/) — the full grammar of
  `needs`, product-kind declarations, and the validation errors.
- [Audit & guarantee tiers](/pangolin/explanation/audit-guarantee-tiers/) — what
  the other four `pangolin verify` rows prove, and the tier the `handoff` row
  sits on.
