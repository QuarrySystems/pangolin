# Serve-Stack Known Issues

Found while bringing `deploy/serve-stack` up from a cold start on Windows +
Docker Desktop and running `client/smoke.mjs` end to end.

The run itself was healthy — `submit → dispatch → reconcile → complete` in 15.7s,
with a 4-entry hash-linked chain, matching merkle/anchor roots, a valid signature,
and an `external-immutable` S3 anchor. Issues 1–5 are about the *operator path*:
the runbook, the config defaults, and the verify UX. None of those indicates a
fault in the orchestration or audit machinery.

**Issues 6 and 7 are different, and the scoping sentence above does not cover
them.** Both came later, from sustained use of this stack rather than from the cold
start, and both are faults in the orchestrator itself rather than in the runbook:
6 is a scaling fault in the publish loop and the client read path, 7 is a
configuration surface that accepts more than the serve loop drives. They are filed
here because this is where the serve-stack findings live, but they want a different
reader.

Line references for issues 1–5 and 7 are to this branch. Issue 6 cites
`@quarry-systems/pangolin-orchestrator@0.4.0` by compiled `dist/` path, because that
is the artifact that was read and measured.

---

## 1. `DOCKER_GID` default of `999` is wrong under Docker Desktop

**Status: FIXED** (docs). `RUNBOOK.md` §4.3 now carries the per-topology table
(`999`/`998` for Engine, `0` for Docker Desktop), states that the socket must not
be statted from the host under Desktop, describes the silent-healthy-but-never-dispatches
failure, and explains why group `0` is not a meaningful additional privilege. The
compose default is unchanged: `999` is correct for the Engine-on-WSL2 topology
Step 1 actually builds.

**Symptom.** `serve` starts, reports healthy, but cannot launch worker containers.

**Cause.** `docker-compose.yml` sets `group_add: - "${DOCKER_GID:-999}"`, and
`RUNBOOK.md` §4.3 documents finding the GID of `/var/run/docker.sock` on a Linux
host — where it is typically the `docker` group (`999`/`998`). Under Docker Desktop
the socket inside the VM is owned differently:

```
$ docker run --rm -v /var/run/docker.sock:/var/run/docker.sock alpine \
    stat -c '%g %U %a' /var/run/docker.sock
0 root 660
```

`root:root`, mode `660`. `serve` runs as uid 1000, so with the `999` default it has
no write access; it needs supplementary group **`0`**.

**Impact.** A Docker Desktop operator gets a healthy-looking stack that silently
cannot dispatch. The runbook offers no clue, because it only covers the
Engine-on-Linux case.

**Suggested fix.** Document the Docker Desktop case in §4.3 (`DOCKER_GID=0`) and
note that the discovery one-liner is the correct method there — statting the socket
from the host does not work, because the socket lives inside Desktop's VM.

Adding group `0` is not a meaningful additional privilege here: mounting the Docker
socket at all is already root-equivalent on the host, so the group is not what
grants the power. Worth stating explicitly so the value doesn't look alarming.

---

## 2. `smoke.mjs` prints follow-up commands that cannot work as written

**Status: FIXED.** `client/smoke.mjs` now prints `../node_modules/.bin/pangolin …`
and carries a comment explaining why `pnpm exec` cannot be used. `RUNBOOK.md` §5.5
and §6.4 use the same form, with the reason stated once in §5.5. The cwd rewrite
was re-confirmed on this branch before the change:

```
$ cd deploy/serve-stack/client && pnpm exec node -e "console.log(process.cwd())"
C:\Users\brett\Documents\Knowledge\agora\deploy\serve-stack
```

**Symptom.** Copy-pasting the commands the smoke script prints fails with an S3
error that mentions neither pangolin nor MinIO:

```
The bucket you are attempting to access must be addressed using the specified
endpoint. Please send all future requests to this endpoint.
```

**Cause.** `client/smoke.mjs:59-62` prints:

```
Follow along / verify (from deploy/serve-stack/client — the CLI resolves
pangolin.config.mjs from cwd; tunnel still up):
  pnpm exec pangolin orch watch <runId>
```

But `pnpm exec` **normalizes the working directory to the package root**:

```
$ cd deploy/serve-stack/client && pnpm exec node -e "console.log(process.cwd())"
C:\Users\...\agora\deploy\serve-stack
```

So the CLI resolves `deploy/serve-stack/pangolin.config.mjs` — the *serve* config —
not `client/pangolin.config.mjs`. The instruction's own premise ("resolves from
cwd") is defeated by the command it recommends.

**Impact.** The advertised verification path fails for every operator on first use.

**Suggested fix.** Invoke the CLI without pnpm's cwd rewrite, e.g.
`../node_modules/.bin/pangolin orch watch <runId>` from `client/`, and update both
`smoke.mjs`'s printed text and `RUNBOOK.md` §5.4. Confirmed working.

---

## 3. Serve config's S3 endpoint has no fallback, so it silently targets real AWS

**Status: FIXED** — fail-fast, as the suggested fix below argues for.

The fix had to respect a constraint the original write-up missed: this config
documents itself as IMPORT-SAFE when `PANGOLIN_S3_ENDPOINT` is absent (header,
lines 7–8), and that property is load-bearing. The CLI imports whichever
`pangolin.config.mjs` sits in cwd for *every* verb, including offline ones like
`pangolin verify bundle.json` that never touch S3. A module-level throw would
break those.

So `endpoint` is now a lazy provider rather than a bare `process.env` read —
import stays clean, and the throw happens on the first S3 call, which is exactly
when an absent endpoint has become a real problem. Verified against the real
config with the variable unset: import succeeds, `readOutbox()` throws
`PANGOLIN_S3_ENDPOINT is not set…`, and nothing reaches `amazonaws.com`.

**Symptom.** The confusing error in issue 2 comes from **Amazon**, not MinIO.

**Cause.** `pangolin.config.mjs:53` (serve):

```js
endpoint: process.env.PANGOLIN_S3_ENDPOINT,
```

with no fallback, versus `client/pangolin.config.mjs:42`:

```js
endpoint: process.env.PANGOLIN_S3_ENDPOINT ?? 'http://localhost:9000',
```

Inside the container `PANGOLIN_S3_ENDPOINT` is always set by compose, so this is
invisible in normal operation. Loaded anywhere else — which issue 2 makes easy —
`endpoint` is `undefined` and the AWS SDK falls back to the real
`s3.<region>.amazonaws.com`. The client then issues live requests against Amazon
for a bucket named `pangolin-data`.

**Impact.** A misconfiguration that should fail immediately and locally instead
produces a plausible-looking S3 error from a completely different service. This
turned a one-line config problem into a lengthy diagnosis, and it sends
unintended requests to a third party.

**Suggested fix.** Either give the serve config the same `??` fallback as the
client, or fail fast with an explicit error when `PANGOLIN_S3_ENDPOINT` is unset.
Failing fast is preferable: a serve config loaded outside its container is a
mistake in every case, and silently defaulting to AWS is the worst available
outcome.

---

## 4. A missing local public key reports `TAMPERED`, not "unverifiable"

**Status: PARTIALLY FIXED — and one premise below was wrong.**

*Correction.* The Impact section claims "the runbook never instructs the operator
to fetch the key." That is false, and was false when written. `RUNBOOK.md` §5.3
("Fetch the serve public key") has existed since the serve-stack landed in #57 —
`git log -S "Fetch the serve public key"` confirms it. The documented happy path
did include the fetch; the cold-start operator skipped it. The most likely reason
is that §5.3's only recipe used `aws s3 cp`, so anyone without the AWS CLI hit a
dead end at exactly that step and moved on.

*What is fixed.* §5.3 now also gives a `minio/mc` container recipe needing no
local AWS CLI, and states plainly that skipping it makes a healthy run verify as
`TAMPERED` — so an operator who sees that verdict checks the key before
concluding anything about the bundle.

*What remains open, and is the real issue.* The tri-state reporting.
`verifySignature` still returns `false` for both "no trust anchor" and "signature
does not match", and the verify output still renders both as `✗ signature false`.
Documentation cannot fix that; it needs the change described under Suggested fix.
Being unable to distinguish an unconfigured verifier from a genuine tamper is the
part that matters, and it is untouched.

**Symptom.** A perfectly good run verifies as:

```
pangolin verify · smoke-…                    ✗ TAMPERED
  ✓ chain      4 entries, hash-linked, no gaps
  ✓ root       merkle = anchored root
  ✗ signature  false
  ✓ anchor     s3:pangolin-audit  (external-immutable)
```

**Cause.** `client/pangolin.config.mjs:70` resolves the trust anchor from a **local
file**:

```js
const PUBLIC_KEY_URL = new URL('./public-key.json', import.meta.url);
```

and its own header comment (lines 18–19) states that `verifySignature` *"reads the
fetched public-key.json lazily and returns false when it is absent."*

`client/public-key.json` is gitignored (`.gitignore:15`) and is not created by any
setup step. Serve publishes the key correctly — it was present in MinIO at
`pangolin-data/public-key.json`, written a full minute before the run — but nothing
fetches it to the client. Copying it down flips the verdict to `✓ TAMPER-EVIDENT`
with `signature true`, on the same unmodified bundle.

**Impact.** This is the most serious item here, for two reasons.

First, the runbook never instructs the operator to fetch the key, so the documented
happy path ends in `TAMPERED` on a healthy run. The natural conclusion is that the
system is broken or the bundle was altered.

Second, and more importantly: **"I have no trust anchor" and "this signature does
not match" are different facts, and the tool reports them identically.** A verifier
that returns `false` for an absent key cannot distinguish an unconfigured client
from genuine tampering — which is precisely the case a tamper-evidence tool exists
to adjudicate. It fails toward a *false alarm* here, which is the safer direction,
but the conflation also means a real tamper could be dismissed as "probably just
the missing key again" by an operator who has been trained by this bug.

**Suggested fix.** Distinguish the states. `verifySignature` should signal absent-key
separately from mismatch, and the verify output should render a third state
(`─ signature  unverifiable (no local public key)`) alongside the existing pass/fail
— the same treatment `handoff` already gets when it reports `n/a` rather than a
tick. Separately, add a fetch step to `RUNBOOK.md` §5 so the documented path
produces a verifiable client:

```bash
docker run --rm --network pangolin-serve-stack_default \
  -e MC_HOST_m="http://minioadmin:minioadmin@minio:9000" \
  -v "$PWD/client:/out" minio/mc \
  cp m/pangolin-data/public-key.json /out/public-key.json
```

---

## 5. `orch watch`'s inline verify under-reports against `pangolin verify`

**Symptom.** The same run, verified two ways, disagrees.

A three-item run with two `needs` handoff edges, watched inline:

```
  ✓ chain        8 entries, hash-linked, no gaps
  ✓ root         merkle = anchored root
  ✓ signature    true
  ✓ anchor       s3:pangolin-audit  (external-immutable)
  ─ handoff      n/a
```

The same run, via `orch audit --out` then `pangolin verify`:

```
  ✓ handoff        2 input refs accounted for
  ─ authorization  not attested
```

**Cause.** Not diagnosed here — the two paths render from different inputs, and
the inline summary appears not to have the binding data the bundle carries.

**Impact.** `watch` is the path an operator actually uses while a run is in
flight, and it is the path `smoke.mjs` recommends. It reports `n/a` for a check
that in fact passed with two accounted-for refs, and it omits the
`authorization` row entirely. An operator reasonably concludes handoff provenance
was never established.

This cuts both ways and the benign direction is the dangerous one: here it
*under*-claims, which is safe in isolation but trains operators to read `handoff
n/a` as normal — so a genuinely absent handoff, in a run where one was expected,
looks identical to this false negative.

**Suggested fix.** Render both paths from the same verification result, or have
`watch` state explicitly that its summary is partial and name the full command.
If the inline path genuinely cannot compute handoff, `not computed` is the honest
label; `n/a` asserts the run had no handoff edges, which was false here.

### 5a. The bundle verify gives handoff a green tick at zero edges

**Status: FIXED.** `checkHandoffClosure` now returns `ok: 'n/a'` at zero edges, so
the row renders `─ handoff  no handoff edges` instead of `✓`. The change was one
line plus its test: the neutral state already existed end to end — `CheckResult.ok`
is `boolean | 'n/a'` (`audit.ts:203`, commented *"prerequisite genuinely absent —
never a false ✓"*) and the renderer already maps it to `─`
(`pangolin-verify/src/render.ts:22`). Handoff simply was not using the state the
type had reserved for it.

The verdict is deliberately unchanged: `intact` tests `handoff.ok !== false`, so
`'n/a'` still cannot fail a bundle. Zero edges was never a *failure* — it was a
non-answer being rendered as a pass. Issue 5 proper (the `orch watch` inline
summary disagreeing with `pangolin verify`) is untouched and still open.

A third run (`converter-loop-proof-1785344533713`, two items, no `needs` edges)
completes the matrix, and it contradicts a reassuring reading of the above:

| | 0 edges | 2 edges |
|---|---|---|
| `orch watch` | `─ n/a` | `─ n/a` |
| `pangolin verify <bundle>` | **`✓ no handoff edges`** | `✓ 2 input refs accounted for` |

The label is honest — "no handoff edges" states exactly what was found. The **tick
is not**. `✓` renders identically to the four checks above it that did real work
(chain linkage, merkle/anchor agreement, signature, anchor immutability), so a
reader scanning the block for ✓/✗ sees five passes and concludes provenance was
verified. Nothing was verified; there was nothing to verify.

This matters most in the case the check exists for. A plan that was *supposed* to
carry handoff edges but lost them — a converter bug, a hand-edit, a refactor that
dropped a `needs` block — produces `✓ handoff no handoff edges` and reads as
success. The check cannot fail for the failure it is meant to catch.

**Suggested fix.** Render the zero-edge case as `─ no handoff edges` (neutral, as
`authorization  not attested` already does) rather than `✓`. The reserved-glyph
distinction already exists in this output; handoff simply is not using it.

---

## 6. The outbox grows without bound, and every client read walks all of it

**Status: FIXED** — changes 1 and 2 below. Change 3 (`listPrefixes`) deferred;
see the note at the end of this section.

**One correction to the plan below.** It claims change 2 "works even without
change 1". That is true for `status()`/`watch()`, and false for `audit()`. The
audit export is published exactly once, on the tick after the epoch seals
(`driver.ts`, the `publishedAudit` guard) — and under fault 1 the loop kept
publishing status records for that run *forever afterwards*. So the audit record
was buried under an ever-growing pile of **newer** records, and a reverse scan
would have walked back over every one of them to reach it. Change 2 only makes
`audit()` cheap because change 1 stops burying it. The order of the fixes matters
more than the write-up suggests, and `test/outbox-growth.test.ts` encodes that
dependency so it cannot be silently reintroduced.

The fixes, as landed in `packages/pangolin-orchestrator`:

1. *Publish loop scoped.* `serve/driver.ts` now publishes a run's final
   all-terminal status **once** and then goes quiet about that run, instead of
   republishing every visible run every tick. The terminal-status set is now
   exported once from the contracts (`TERMINAL_STATUSES`) rather than re-declared
   — worth noting because the driver needs the 5-member set including `denied`,
   and four other modules carry 4-member copies that omit it.

   The guard marks a run as announced only **after** the publish resolves. Marking
   first is the obvious way to write it and it is wrong: a transient publish
   failure would retire the run permanently, so the final status would never land
   and no later tick would retry it. The existing error-resilience test in
   `serve-driver.test.ts` caught exactly that during this change.

2. *Reads take one record, not all of them.* New optional
   `SubmissionTransport.readLatestOutbox(runId, kind?)`, implemented on
   `MailboxSubmissionTransport` as a reverse scan that stops at the first match.
   `status()`, `audit()` and `watch()` use it. Optional on the interface, with a
   `readOutbox` fallback in `OperationsApi`, so third-party transports are
   unaffected.

*Not done: change 3, `MailboxStore.listPrefixes`.* It is a real gap — enumerating
run ids still costs one key per record rather than one per run — but it has no
consumer in-tree today: it is a prerequisite for a client-side `listRuns()` that
does not exist yet. Adding an SPI member with no caller is speculative, and change
1 substantially relieves the symptom that motivated it, since the record count
per run stops growing with uptime. Worth doing alongside `listRuns()`, not before.

**Existing stacks are not rewritten.** The records already accumulated stay where
they are; what changes is that reads no longer walk them and new ones stop piling
up.

**Symptom.** Reading one completed run takes over a minute, and the cost is
proportional to how long the stack has been up rather than to anything about the
run. Measured 2026-07-30 against a stack with 21 historical runs:

```
run fu1-posfix2-…-f466e5b510a6   (the run itself took ~67 seconds)
  OperationsApi.audit()          71,027 ms
  transport.readOutbox()         60,807 ms   → 23,307 records

run chain-1785341107099
  mailbox list of its outbox                 → 34,937 keys

a runId that does not exist
  OperationsApi.audit()               5 ms
  transport.readOutbox()              3 ms   → 0 records
```

The 5 ms case is the control: the cost is entirely the outbox scan, not the bundle
assembly, the anchor, or the signature check.

A related consequence, met first: listing the outbox root to enumerate run ids —
`mbox.list('orchestrator/outbox/')` — did not complete within 120 s.

**Cause.** Two independent things compound.

*Writes are amplified per tick.* `serve/driver.js` calls
`orchestrator.getStatus()` **with no argument**. `getStatus(runId)` passes that
straight through:

```js
// dist/orchestrator.js
getStatus(runId) { const items = this.store.getItems(runId); … }
```

and the SQLite store treats an absent runId as "everything":

```js
// dist/runstate/sqlite.js
getItems(runId) {
  const rows = (runId
    ? this.db.prepare('SELECT * FROM items WHERE run_id=? ORDER BY rowid').all(runId)
    : this.db.prepare('SELECT * FROM items ORDER BY rowid').all());
  …
}
```

The driver then groups by runId and publishes one status `OutboxRecord` **per run,
per tick** — including for runs that reached a terminal state days earlier. Items
are never deleted, so a run keeps accruing outbox records for the rest of the
stack's life. That is how a 67-second run ends up with 23,307 of them.

*Reads are unindexed.* `MailboxSubmissionTransport.readOutbox` lists the run's
prefix and then issues a **sequential `get` per key**:

```js
async readOutbox(runId) {
    const keys = (await this.mbox.list(`${this.ns}/outbox/${runId}/`)).sort();
    const out = [];
    for (const k of keys) {
        const b = await this.mbox.get(k);
        if (b?.length)
            out.push(dec(b));
    }
    return out;
}
```

Every client-facing read goes through it — `status()`, `audit()`, and `watch()`,
which polls `status()` in a loop.

**Impact.** Storage grows as O(runs × ticks) with no pruning, and client read cost
grows with it. Three consequences worth separating:

- `audit()` reads the entire outbox to find one record. It wants the last entry of
  `kind: 'audit'`; it fetches and decodes every status record ever published for
  that run to get there.
- `watch()` degrades as it waits. Its per-poll cost rises with uptime, so the
  longer a run takes, the more expensive each check on it becomes — the opposite of
  what a polling API should do.
- An unattended driver is the worst case, and is how this surfaced. A nightly
  process that polls enrolled runs to terminality pays a full scan per run per
  sweep, and the scan grows *while it waits*, because the serve loop keeps
  publishing. At a 60-second poll interval a single sweep can exceed its own
  interval, so a long night degenerates into back-to-back scans and makes little
  progress. There is no cheaper readiness probe available to a client: `status()`
  walks the same records.

None of this is visible in a short-lived stack. A cold start, a smoke run, and a
teardown never accumulate enough records to notice — which is why issues 1–5 did
not surface it.

**Suggested fix.** Three separable changes, each useful alone:

1. *Stop republishing terminal runs.* Scope the publish loop — either
   `getStatus(runId)` per active run, or skip runs whose items are all terminal.
   This is the amplification, and fixing it bounds the growth at the source.
2. *Let `audit()` find its record without a full scan.* Outbox keys are
   zero-padded and lexicographically sortable by seq
   (`String(++this.seq).padStart(12, '0')`), so scanning keys in reverse and
   stopping at the first `kind: 'audit'` is O(1) in the common case. This works
   even without change 1 and needs no schema change.
3. *Give `MailboxStore` a delimited list.* Enumerating run ids needs one entry per
   run, not per record — S3 offers this natively via `Delimiter: '/'` and
   `CommonPrefixes`, but `MailboxStore.list(prefix): Promise<string[]>` cannot
   express it. A `listPrefixes(prefix)` sibling would make run enumeration
   O(runs) instead of O(records), and is a prerequisite for any client-side
   `listRuns()`.

Changes 1 and 2 are independent: 1 bounds what accumulates, 2 makes the existing
accumulation cheap to read past. Doing 2 first gives immediate relief on stacks
that already have large outboxes, since it does not require rewriting history.

---

## 7. `serve()` drives exactly one queue, so a multi-queue config is half-inert

**Status: FIXED.** The suggested fix below offers a fork — drive every configured
queue, or refuse to start when queues are declared that the loop will not tick.
What landed resolves it rather than picking a side, because the two options answer
different deployments:

- **An explicit `queue` still drives exactly that one.** One serve process per
  queue stays possible, and this path is unchanged.
- **Omitting `queue` now drives every configured queue**, instead of silently
  defaulting to `default`. The orchestrator already holds and validates the whole
  map (`getConfiguredQueues()` exposes it), so a config declaring queues the loop
  ignored was half-inert *by default* — which is exactly how this was hit.
- **Either way, undriven queues are named at boot.** When an explicit `queue`
  leaves others unticked — legitimate, so this is a notice and not a refusal —
  serve warns and names them. Documenting alone would not have been enough: the
  failure produced no signal to correlate with a doc, which is what made it
  expensive to diagnose.

`deploy/serve-stack/serve-entrypoint.mjs` passes no `queue`, so **this stack now
drives both `default` and `gated`**, and the config comment calling `gated` "a
dedicated queue carrying the pipeline pattern" is no longer aspirational.

**Follow-up: driving N queues reintroduced this bug's own failure mode, and that
is now fixed too.** The first cut ticked queues in a bare
`for (const q of queues) await tick(q)`. A throw from an early queue aborted the
whole pass — later queues never ticked, status never published — and because each
pass restarts at the same failing queue, one deterministic fault starved every
queue behind it indefinitely. Worse at boot: the reconcile-first tick rejected out
of `serve()` entirely, so a single broken queue meant *no* queue was ever driven
and the container crash-looped under `restart: unless-stopped`, serving nothing.

Now every configured queue is attempted on every pass regardless of its siblings,
and failures are collected rather than swallowed:

- A lone failure rethrows **as-is**, so single-queue deployments see byte-identical
  error surfacing. Several become an `AggregateError` naming each, because
  reporting only the first hides the rest.
- The pass still ends up failing, so a broken tick does not read as a healthy
  iteration — `/readyz` staleness depends on passes completing cleanly.
- A reconcile-first failure now reports and starts the loop anyway instead of
  rejecting. `lastTickOkAt` stays unset, so `/readyz` returns 503 `not-ready`
  until a tick succeeds, while `/healthz` stays up — liveness drives restarts and
  a dependency outage must not cause a restart storm, which is the split
  `evaluateHealth()` already documents. There was no principled reason for the
  same failure to be fatal at boot but recoverable one iteration later.

Ticking is sequential on purpose, not a missed parallelisation: the orchestrator
is a single-writer design (one SQLite writer, one shared lock manager), so
concurrent ticks would race. Each `tick(q)` is a queue-filtered query.

**Second follow-up: a queued cancel now beats the first dispatch.** The loop drains
the transport before its tick, so a cancel beats the dispatch it targets. The
reconcile-first tick that runs once before the loop did not, so a cancel queued
while the process was down lost the race to the very item it was meant to stop.

That was mostly theoretical until `serve()` began driving every configured queue.
Items stranded on a previously-undriven queue become dispatchable on the next
start, and cancelling them is the operator's only remedy — one that could not work,
because cancellation is processed by the loop that had never ticked that queue. So
the first start after upgrading was exactly the moment the remedy was needed and
exactly the moment it failed.

Ingress (submissions → extends → control) now drains once before the
reconcile-first tick as well, as a single ordered unit. **The order is
load-bearing:** draining control alone is the obvious fix and it silently breaks a
cancel that arrives in the same batch as its own run, because `cancelRun` on a run
the store has never seen iterates an empty item list and returns *without throwing*
— so the envelope is acked and destroyed against a run that lands moments later.
(`closeRun` throws on an unknown run, so it survives; the two diverge here.) Both
directions are pinned by tests.

*Operator note for the upgrade:* if work is sitting `ready` on a queue this stack
did not previously drive, decide about it before starting the new build — on that
first start it will either run or be cancelled, and now a cancel queued beforehand
will actually be honoured.

**No reader changes are needed.** `queue` is a run-level field — `WorkItem` carries
none — so a run belongs to exactly one queue; the outbox is keyed by `runId`; and
the driver groups a run's items by `runId` regardless of queue. `pangolin-product`
contains no reference to `queue` at all. Driving more queues changes *which* runs
progress, not the shape of anything a client reads.

*Behaviour change worth flagging:* a deployment that configured extra queues and
passed no `queue` gets those queues driven now where they were inert before. That
is the bug being fixed, but it is a real change in what a running process does.
Pass `queue` explicitly to keep a single-queue process.

**Symptom.** An item submitted to a configured, validated queue other than the one
`serve` happens to tick sits at `ready` forever. No error appears in the serve log,
in `orch status`, or in the audit chain. The serve loop continues dispatching other
work normally throughout.

**Cause.** `packages/pangolin-orchestrator/src/serve/driver.ts:57` reads

```ts
const queue = opts.queue ?? 'default';
```

and lines 84 and 135 call `opts.orchestrator.tick(queue)` — one queue, singular.
`ServeOptions.queue` (`:11`) is a single optional string.
`deploy/serve-stack/serve-entrypoint.mjs` passes no `queue`, so the deployed stack
ticks only `default`.

Meanwhile `PangolinOrchestrator` accepts and validates the full map
(`orchestrator.ts:105-110`), and this stack's own config declares two queues:

```js
const queues = {
  default: { concurrency: 2 },
  gated:   { concurrency: 2, pattern: pipeline },
};
```

`gated` is declared, validated, and never driven. `tick` filters
`i.queue === queue` (`tick.ts:50`), so nothing in that queue is ever considered
ready, fired, or reconciled.

**Impact.** Silent and total for the affected queue. Observed directly: a two-item
run submitted to `gated` sat `ready` with `blockedBy: []` for 20+ minutes while the
loop dispatched unrelated work; resubmitted unchanged to `default` it completed in
67 seconds.

Two things make this worse than a normal misconfiguration:

- The config is *valid*. The orchestrator accepts the queue, so there is no startup
  warning and no obvious place to look.
- **`orch cancel` cannot rescue it.** Cancellation is processed by the same tick
  loop, so a run stranded on an unticked queue cannot be cancelled either. The only
  exit is to stop caring about that run id — and because submit is idempotent by id,
  the id stays occupied.

The comment in `pangolin.config.mjs` describing `gated` as "a dedicated `gated`
queue carrying the pipeline pattern" is therefore aspirational as deployed.

**Suggested fix.** Either drive every configured queue, or refuse to start when the
config declares queues the loop will not tick.

Driving all of them looks closest to intent — the orchestrator already holds the
map, so `serve` could iterate `Object.keys` of it rather than taking a single name.
If a single-queue serve process is deliberate (one process per queue, say), then the
startup check is the cheaper fix: log or fail on
`configuredQueues - {tickedQueue}` being non-empty, so the operator learns at boot
rather than from a run that never moves.

Documenting alone would not be enough here. The failure produces no signal to
correlate with a doc, which is what makes it expensive to diagnose.

---

## Related: CRLF on shell scripts

A fifth issue — all four tracked `.sh` files checking out as CRLF on Windows and
breaking `minio-init` — is fixed separately on `fix/windows-crlf-shell-scripts`.
