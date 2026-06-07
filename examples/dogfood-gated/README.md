# dogfood-gated — agora exercises the pattern layer's gated circle-back

## Run lineage

Run 1 (#36) proved independent fan-out: four file-disjoint maintenance tasks
dispatched in parallel, patches back with an audit trail.

Run 2 (#51) proved the typed-product handoff on a real dependent chain: item B
genuinely builds on A's edit, wired by `needs`, with provenance closure live.

**Run 3 proves the gated circle-back (this example).** Gate red → audited
respawn → fix consumes findings by provenance → downstream remapped to the
fix's patch. All of this live, with real Claude workers on agora's own source
tree, and every dispatch sealing model + cost evidence (PR #52).

---

## The 3-node plan

Plan id: `dogfood-gated-run3`. Queue: `default`. Pattern: `pipeline`. One gate.

| Item | Subagent | Model | What |
|---|---|---|---|
| `write-page` | `page-writer` | standard | Creates `docs-site/src/content/docs/explanation/execution-patterns.md` from a **deliberately partial** seed view (the pattern-layer spec, `examples/pattern-dogfood/README.md`, and one style-reference page — not the source code). |
| `fact-check` | `fact-checker` | **max** | The **gate**. Subject's patch materialized at `inputs/work`, git-applied pre-agent. Fact-checks every claim against the seeded source files under the **material-accuracy bar**: a finding is a claim that would mislead a reader about actual behavior — invented APIs/fields/config shapes, wrong semantics, wrong names or sequencing (wording imprecision and incompleteness are NOT findings; the four-attempt calibration record in the run-3 spec §10 explains why the original any-unsupported-claim bar made green structurally unreachable). Findings → `outputs/findings` (exact path, no extension) as a JSON array of `{ claim, reality, evidence }`. Writes the file only if findings exist. Subagent-level verify: `test ! -s outputs/findings` — flips `verify.passed=false` when findings are non-empty (the done-but-red state that triggers the circle-back). |
| `announce` | `announcer` | standard | Adds a CHANGELOG.md entry. On a red gate this item is **skipped** (§7 engine PR), then respawned as `announce~2` with `needs.work` remapped to the fix's patch. |

The fix item (`fact-check-fix-1`) is spawned automatically by the pattern layer
when the gate fires. Its subagent is `page-fixer` (model **max**, with the SAME
source seeds the gate judges against — a source-blind fixer's rewritten prose
drifts, and `maxFixAttempts: 1` is the only value the landed respawn semantics
support, so the fix must converge in one round). The `page-fixer` receives
`inputs/work` (the page-creating patch) and `inputs/findings` as data. It
reconstructs the full corrected page from the patch's `+` lines — it does NOT
git-apply the patch — so its escaped patch is a clean cumulative new-file patch
that applies downstream.

`page-fixer` deliberately omits the `apply-work-patch` capability. Applying the
patch via setup would bake the page into the baseline, making the fix's escaped
patch a delta rather than a cumulative new-file patch, and the downstream
`fact-check~2` and `announce~2` workspaces (which do not contain the page)
would fail to apply it.

---

## Prerequisites

- **Docker reachable** (local Desktop, or `DOCKER_HOST` pointing to a remote daemon).
- **`ANTHROPIC_API_KEY`** — either via `pnpm start:env` (reads `../../.env`) or
  exported in your shell.
- **Worker image rebuilt from this branch** — mandatory (see below).

### Worker image rebuild — mandatory

PR #52's `--model`/level mapping and the sentinel `usage` block are worker-side
code. A run-2-era local image silently ignores both: Row 4 of the harness
(the evidence table) will fail with "all sentinels lack usage" — this doubles as
the stale-image preflight. GHCR anonymous pull is unauthorized; local build is
the supported path.

From the **repo root**:

```sh
docker build -f docker/agora-worker/Dockerfile -t ghcr.io/quarrysystems/agora-worker:main .
```

---

## Running

From this directory (`examples/dogfood-gated`):

```sh
# reads ../../.env for ANTHROPIC_API_KEY
pnpm start:env

# or with the key already exported
pnpm start
```

Timeout: 15 minutes (red arc = up to 5 mostly-sequential dispatches; concurrency 2).

---

## What the driver asserts

The driver IS the acceptance test (spec §4). After terminal state it assembles
the audit bundle and exits non-zero unless all four rows hold:

### RED path (gate fires)

The fix item id `fact-check-fix-1` in the grown item graph indicates a red arc.

1. **Provenance closure over the grown graph** — `verifyBundle` → `intact: true`
   AND `checks.handoff.ok === true`.
2. **Red-path circle-back** —
   - A `run.extended` audit entry with `itemId === 'fact-check'` and
     `actor === 'pattern:default'`.
   - `fact-check-fix-1` status `done`.
   - `fact-check~2` status `done` AND `verify.passed !== false` (green gate copy).
   - `announce~2` status `done` with `inputRefs.work === fact-check-fix-1.resultRef`
     (remap by ref equality — both confirmed in the bundle).

### GREEN path (gate passes)

When the gate finds no findings the driver prints:

```
GATE GREEN — no circle-back exercised
```

and exits 0 (honest). No circle-back is exercised. See rerun protocol below.

### Row 4 — evidence table (#52, first live use)

The driver prints a per-dispatch table:

```
item | requested | actual model(s) | costUsd | turns
```

Best-effort by contract — missing usage is printed as `(not captured)`. The row
fails only if ALL sentinels lack usage (stale worker image signal).

---

## R6 rerun protocol

If the run comes back GREEN (gate found no findings), rerun once with the
**block-pipeline-runner page** as the subject. This is a config/plan swap, not a
code change:

1. Edit `src/config.ts` — swap `EXECUTION_PATTERNS_TOPIC` for a new topic
   pointing at the block-pipeline-runner page and its seeds.
2. Edit `plan.json` — update `workerInput.instructions` for `write-page`,
   `fact-check`, and `announce` to reference the new page path.
3. Re-run `pnpm start:env`.

---

## Verify the proof — the auditor command (zero credits, separate process)

A successful run persists two text artifacts beside this README:

- `bundle.json` — the exported `AuditBundle` (the artifact you hand an auditor)
- `verify-context.json` — the signer **public** key + the anchored root(s)

`agora.config.mjs` here is a **verify-only** config: a read-only anchor serving
the persisted roots and a `verifySignature` bound to the persisted public key.
Any process holding the two files can re-verify the full proof — no store, no
Docker, no API key, no access to the run that produced it:

```sh
# from this directory
pnpm exec agora verify bundle.json --full
```

Expected: `✓ TAMPER-DETECTING` with all five rows green (chain / root /
signature / anchor / handoff) and the full hash-linked ledger — including the
`item.skipped` → `run.extended` sequence that IS the circle-back, readable
straight off the proof. The committed `bundle.json` is a real run's sealed
output (run id `dogfood-gated-run3`, 2026-06-07, $3.11 of real model spend):
clone the repo and the command above works forever.

## After the run

Patches land in `examples/dogfood-gated/patches/`. Review before applying.

### GREEN arc

Apply the single `write-page.patch` and `announce.patch` from the repo root,
review, then let CI confirm.

### RED arc — merge protocol

Apply in this order from the repo root:

```sh
# 1. The FIX's patch — cumulative new-file (the corrected page)
git apply --stat examples/dogfood-gated/patches/fact-check-fix-1.patch
git apply        examples/dogfood-gated/patches/fact-check-fix-1.patch

# 2. announce~2's patch — CHANGELOG entry written against the fix's page
git apply --stat "examples/dogfood-gated/patches/announce~2.patch"
git apply        "examples/dogfood-gated/patches/announce~2.patch"
```

`write-page.patch` is the raw (unreviewed) original; leave it unapplied as
history. Do NOT apply `write-page.patch` and `fact-check-fix-1.patch` together
— both create the same file.

### Sidebar follow-up (at merge time)

Add the new page to the Explanation sidebar in `docs-site/astro.config.mjs`:

```js
{ slug: 'explanation/execution-patterns' }
```

Also add the run-2 page that was missed:

```js
{ slug: 'explanation/typed-product-handoff' }
```

Both belong in the `Explanation` sidebar group (lines ~55–66).
