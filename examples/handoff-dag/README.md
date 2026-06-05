# handoff-dag — §8 acceptance example

Demonstrates typed-product handoff: a downstream DAG node builds on an upstream node's
patch, with every byte provenance-sealed and verifiable.

## What this example proves

- **Dependent edit via `needs`**: node B (`apply-patch`) declares
  `needs: { patch: { from: 'edit-a', select: { kind: 'patch' } } }` — no hand-written
  `depends_on`. The orchestrator auto-unions the `needs` binding into `depends_on` at
  submit-normalization, so B fires only after A reaches `done`.
- **Content-addressed handoff**: A's `result_ref` (a content-addressed patch artifact) is
  resolved at fire time and passed to B as `inputs.inputRefs.patch`. B's
  `agora-setup.sh` initialises the repo (`git init -q`) and then runs
  `git apply inputs/patch.diff` so the downstream worker literally builds on the upstream
  edit.
- **Provenance closure**: after both items complete, `verifyBundle` proves the chain —
  every `inputRefs` value in every dispatch manifest must be a sealed `resultRef` (or
  `outputRef`) of a completed item in the same run. A run with a tampered or fabricated
  ref fails `checks.handoff.ok`.

The guarantee tier is **tamper-detecting** (LocalAnchor stores the Merkle root in SQLite).
Swap `LocalAnchor` for `S3ObjectLockAnchor` for `external-immutable` / tamper-evident.

## Live demo (requires Docker + Anthropic API key)

```sh
# From repo root — reads ../../.env for ANTHROPIC_API_KEY
pnpm --filter handoff-dag-example start:env
```

Or set the key in your shell:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
pnpm --filter handoff-dag-example start
```

The demo:
1. Registers a `code-edit` subagent that renames `GREETING → SALUTATION` in `src/main.ts`
   and an `apply-patch` subagent whose `agora-setup.sh` first initialises the repo
   (`git init -q`) then applies the patch (`git apply inputs/patch.diff`).  Setup runs
   after the inputs/ overlay (so `inputs/patch.diff` is already present) but before the
   adapter, which is why the repo must be initialised inside the script.
2. Submits `plan.json` (2 items, `apply-patch` wired via `needs` only).
3. The `serve` driver ticks the AgoraOrchestrator until both items are terminal.
4. Prints each item's `resultRef`.
5. Assembles the audit bundle and calls `verifyBundle` for the provenance-closure proof.
6. Exits non-zero if any item failed, `report.intact === false`, or
   `report.checks.handoff.ok !== true`.

### Prerequisites

- Docker reachable (local Docker Desktop, or `DOCKER_HOST` pointing at a remote daemon).
- Worker image pullable: `ghcr.io/quarrysystems/agora-worker:latest`.
- `ANTHROPIC_API_KEY` set (Claude runs inside the worker container).

## CI smoke test (no Docker / no API key)

```sh
pnpm --filter handoff-dag-example test
```

Runs `test/handoff.test.ts` with vitest. Uses a fake executor (no containers, no LLM).
Verifies:
- `plan.json` has exactly 2 items; `apply-patch` declares `needs.patch` binding `edit-a`
  with `select: { kind: 'patch' }` and has no hand-written `depends_on`.
- A real `AgoraOrchestrator` with the fake executor drives the plan to completion — both
  items reach `done`.
- The fake executor builds REAL `buildManifest`-produced manifests (with `inputRefs`
  populated from `item.inputs.inputRefs`), stores them in an in-memory blob map, and
  reconciles `edit-a` with a `resultRef`.
- `verifyBundle` reports `intact: true` and `checks.handoff.ok === true` — the
  `inputRefs` in `apply-patch`'s manifest resolve to `edit-a`'s `resultRef`.
