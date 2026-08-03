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

**Status: FIXED — and one premise below was wrong.**

*The tri-state landed.* `verifySignature` may now return `'n/a'` alongside
`true`/`false`, and the three states are kept apart end to end:

| verifier says | `checks.signature.ok` | `intact` | `claim` | renders |
|---|---|---|---|---|
| verified | `true` | ✓ | may be tamper-evident | `✓ signature  true` |
| does not match | `false` | ✗ | tamper-detecting | `✗ signature  false` |
| no trust anchor | `'n/a'` | ✓ | tamper-detecting | `─ signature  unverifiable — no trust anchor (public key) available` |

Most of the machinery was already there and unused: `CheckResult.ok` was already
`boolean | 'n/a'`, `intact` already tested `sigOk !== false`, `claimFor` already
required `sigOk === true` for the tamper-evident claim, and both renderers already
mapped `'n/a'` to `─`. The value even flowed through `verify()` untouched at
runtime — only the *type* forbade returning it, and no `detail` explained it. So a
missing key now reports `TAMPER-DETECTING` with an explanatory signature row instead
of `✗ TAMPERED`, and **a real mismatch still reports `✗ TAMPERED`** — separating the
states must not soften the one that matters, and a test pins that.

Three ways to reach `'n/a'`, distinguished by `detail` because the remedy differs:
`no signature on the anchored root` (nothing to check), `no verifier configured`
(nothing to check with), and `unverifiable — no trust anchor (public key) available`
(a verifier that cannot resolve the key).

The actually-broken code was the serve-stack client's own verifier, which caught
*everything* and returned `false` — swallowing "file absent" and "verification
failed" identically. Its `try` is now narrow: only the key load is forgiven, and
`verifyEd25519`'s verdict is returned untouched. `pangolin-verify`'s own path was
already correct (it passes `undefined` when there is no trust root, which yields
`'n/a'`).

*Still worth knowing:* the trust anchor is fetched from the same MinIO that stores
the bundles, so an attacker controlling that store controls both the bundle and the
key it is checked against. That is a property of this dev topology, not of the fix;
the config documents the KMS / trust-root-manifest path as the production answer.

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

**Status: FIXED — diagnosed, and the guess below was wrong in both directions.**

*The cause.* The Cause section says "the two paths render from different inputs, and
the inline summary appears not to have the binding data the bundle carries." The
first half is right, the second is not: `assembleBundle` fetches the manifests into
`bundle.manifests`, so `watch` has every byte it needs. The paths differ in **which
report they render**:

| path | renders |
|---|---|
| `pangolin verify` | `verifyBundle(bundle, deps)` — freshly **recomputed** (`cmd-verify.ts` renders `{...bundle, report}`) |
| `orch watch` | `renderVerification(bundle)` — the report **embedded** in the bundle |

And `assembleBundle` built that embedded report with `verify()`, the chain/store-only
verifier: chain + root + signature + anchor, and nothing else. It hardcodes
`handoff: { ok: 'n/a' }` and never sets `authzTier`. So three checks that only
`verifyBundle` performs were missing from **every** bundle ever assembled.

*The severity was understated.* The write-up says the disagreement "under-claims,
which is safe in isolation." True of handoff and authorization. The third missing
check is **manifest integrity**, and its absence is a false negative on a tamper
check, not an under-claim. A forged manifest that `verifyBundle` reports as
`✗ TAMPERED` with `failure: 'manifest'` rendered as a clean bill through the embedded
report. `test/audit/bundle-report-completeness.test.ts` demonstrates exactly that.

*And it was never only about `watch`.* The embedded report is what several callers
**gate** on — `orch audit` takes its exit code from `bundle.report.intact`, as do
`examples/demo-claims-appeals` (`:257`). Those were blind to the same three checks,
so `orch audit` exited 0 on a bundle whose manifests were forged.

*Correction to an earlier draft of this entry:* it also named
`examples/appendable-stream`. That was wrong — it recomputes with `verifyBundle`
before gating, so it was never affected.

*The fix* is at the source rather than in `watch`: `assembleBundle` now computes the
embedded report with `verifyBundle`, so every consumer of `bundle.report` gets the
complete verdict and the two paths agree check-for-check. The dead `exportStore`
shim went with it — `verifyBundle` builds an equivalent store internally.

*Still true, and deliberate:* a report embedded in a bundle **read from disk** is
attacker-controllable, so a verifier must still recompute rather than trust it.
`pangolin verify` and `pangolin-verify`'s CLI both already do. This fix makes the
embedded report honest; it does not make it authoritative.

*One residual divergence, by design:* `assembleBundle` takes no `verifyTimestamp`, so
the embedded report's `time` check stays `'n/a'` even where a caller could verify a
trusted-time token. Threading it would mean widening `OperationsApiDeps` too, and
`time` is explicitly informational — it never gates `intact`/`failure` — so this is
recorded rather than fixed.

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

3. *`MailboxStore.listPrefixes` — **DONE**, together with the consumer that makes it
   usable.* Deferred at first on the grounds that it had no in-tree caller, which
   turned out to be the wrong reason: within a day the gap was hit directly, and the
   only way to answer "what runs exist?" was opening the serve container's SQLite by
   hand — a workaround this file had to document. Landed with `transport.listRuns()`,
   `OperationsApi.listRuns()` and a `pangolin orch runs` verb, so the cheap query is
   reachable from a client. Optional on both seams; callers fall back to `list`.

**Existing stacks are not rewritten by the code change** — but this one was pruned
separately, see 6c.

### 6a. Measured again on 2026-07-31, and the numbers moved the plan

Re-measured against the live stack (still on the pre-fix build, up 18h):

| | |
|---|---|
| runs (outbox prefixes, and distinct runs in the serve DB — they agree) | **95** |
| items of actual work | **105**, all terminal |
| outbox objects | **1,701,236** |
| outbox size | **1018 MiB** |
| delimited list (`Delimiter:'/'`, what change 3 would expose) | **2 s** |
| recursive list (what `list()` forces today) | **~8 min** |

~17,900 records per run, for 105 items of work. The 2 s vs 8 min gap is change 3's
entire case, on real data.

Three things this changed:

**Change 1 does not bound a STUCK run — FIXED.** `publishedTerminal` suppresses only
when *every* item is terminal, so a run with one permanently-stuck item republished
identical bytes every tick forever — precisely the stranded-queue scenario of issue 7,
and any run whose executor never reconciles. The serve loop now fingerprints a run's
status and publishes only on a real change, which covers stuck runs and cuts writes
for slow runs generally.

The terminal guard is kept rather than folded in: it short-circuits on item statuses
alone, so a settled run never pays to fingerprint its whole body every tick. The
fingerprint is a digest rather than the body, so the in-memory map is proportional to
run *count* and nothing else, and it is recorded only after the publish resolves —
same reasoning as the terminal guard, since a failed publish must not be remembered as
delivered. Every distinct change is still published, including changes to `blockedBy`,
`resultRef`, `manifestRef` and `verify` that leave the status strings untouched.

**Change 2 fixed the GETs, not the LIST — and the follow-up was then NOT built,
deliberately.** `readLatestOutbox` still lists the whole run prefix before scanning
backward. Eliminating 23,307 sequential `get`s was the 60 s win, but the list stays
proportional to records, and S3 cannot page backwards. The obvious next step was a
**latest pointer** — `publish` also overwriting `outbox/<runId>/latest.json` — making
reads O(1) and independent of key ordering.

It was dropped because its own justification expired. That design was worth two extra
writes per publish, plus a consistency surface, when a run held 23,307 records.
Publish-on-change and the prune took a run to **~2 records**, so listing them costs
about what one `GET` costs, and a pointer would buy close to nothing for real added
complexity. Measured after both: `orch audit` on a historical run went 71,027 ms →
**738 ms** without it.

Recorded rather than silently skipped, because the reasoning is the reusable part: the
fix at the source removed the need for the optimisation downstream. If a future
workload puts many hundreds of genuine transitions on one run — a large DAG polled by
`watch()` — the pointer becomes worth revisiting, and this is the note that says why.

**A correctness bug was hiding under the ordering assumption.** See below.

### 6c. The accumulated backlog was pruned (2026-07-31)

The code fixes stop growth; they do not remove what had already accrued. The stack was
pruned separately after deploying them.

| | before | after |
|---|---|---|
| outbox objects | 1,701,236 | **193** |
| outbox size | 1018 MiB | **360 KiB** |
| full recursive enumeration | ~8 min | **3 s** |
| `orch audit`, historical run | 71,027 ms | **738 ms** |

1,841,819 objects were deleted across 96 runs — more than the earlier count because the
pre-fix build kept publishing while the measurement was taken.

**The rule was a key-name filter, not a heuristic**, and that mattered: delete every
legacy 12-digit key, keep every clock-seeded 16-digit one. Safe only because the
post-restart republish had given *every* run a current status **and** a current audit
export in the new format — checked across all 96 before deleting anything, rather than
assumed. Nothing outside `mailbox/orchestrator/outbox/` was listed, let alone deleted:
submissions, control, extends, dead-letter, storage artifacts and `public-key.json` sit
elsewhere in the bucket, and the audit *chain* is in a different bucket entirely.

Verified after: `orch audit` on a pruned historical run assembles, and
`pangolin verify` reports `✓ TAMPER-EVIDENT` with `✓ handoff 2 input refs accounted
for`. Pruning cost nothing that verification depends on.

*Nothing prunes automatically.* Growth is now proportional to work done rather than
uptime, so this should not recur at that scale — but there is still no retention
policy, and that remains unaddressed.

### 6d. The fix held — confirmed 42 hours later (2026-08-02)

6c closes on a prediction: *"Growth is now proportional to work done rather than
uptime, so this should not recur at that scale."* That is the one claim in this
issue a measurement taken at deploy time cannot support, because **a prune alone
looks identical to a fix when you measure immediately after both.** Level and
slope are only separable by waiting.

Measured from a consumer against the same deployment after 42 hours of
continuous uptime — `pangolin-serve` reporting orchestrator `0.4.0`, image built
2026-07-31. Five runs spanning that whole window, three `audit()` repetitions
each, medians, first call discarded as warm-up:

| run | stack uptime SINCE it was created | `audit()` |
|---|---|---|
| `loop1-guard-…` | ~42 h | 24 ms |
| `loop2-charter-…` | ~37 h | 22 ms |
| `loop3-sealed-…` | ~2.3 h | 19 ms |
| `loop5-layout-…` | ~0.8 h | 20 ms |
| `loop6-runbook-…` | ~0.05 h | 22 ms |
| a runId that does not exist | — | 2 ms |

**No slope.** The amplification's signature was cost rising with how long the
stack stayed up *after* a run was created; under the old mechanism `loop1` had 42
hours in which to accumulate and `loop6` had three minutes, and they differ by
noise. A reset level with the mechanism intact would have re-accumulated
measurably over that window. It did not.

The nonexistent-runId floor of 2 ms is carried because it is what makes the rest
meaningful: it shows the remaining cost is the round trip rather than a scan, so
19–24 ms is not a smaller scan but effectively no scan.

**What this does not establish.** One deployment, one consumer, 42 hours. It says
the mechanism is not re-accumulating at this scale of use; it says nothing about a
busier stack, and 6c's closing point stands unchanged — there is still no
retention policy, so growth proportional to *work done* is unbounded over a long
enough horizon. This confirms the shape of the curve, not that it has a ceiling.

Filed by the consumer that reported the original 71,027 ms, which had been telling
its operators to raise their poll interval on the strength of it for two days
after it stopped being true.

### 6b. Outbox keys collided across restarts (fixed)

`seq` was a per-instance counter seeded at 0, and mailbox writes are overwrites, so
every `serve` restart rewound it and re-minted keys the previous process had used.
Records written before the restart were clobbered — eventually including a run's
`kind: 'audit'` record, which is what `orch audit` needs, so a sealed run could report
"no audit export published yet". And the lexically-greatest key stopped being the
newest, so `status()` could return a pre-restart record and appear to go backwards.

Not exhibited on this stack only because it has run as a single process: the run
inspected spans `000000000002` → `000001204974` with timestamps in step. The next
restart is what would have broken it.

The sequence is now clock-seeded and monotonic, with a per-instance discriminator for
the same-millisecond case. This also repairs the premise change 2 was documented on —
"lexical key order IS publication order" was only ever true within one process.

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
Items stranded on a previously-undriven queue become dispatchable on the next start,
so the first start after an upgrade is exactly when an operator would reach for a
cancel — and, with serve stopped for that upgrade, exactly the case this race broke.

(An earlier draft of this paragraph said cancelling stranded work "could not work,
because cancellation is processed by the loop that had never ticked that queue." That
repeated the mistaken claim corrected under this issue's Impact section below.
Cancellation is not queue-scoped and always worked while serve was running; the race
fixed here is specifically about a cancel queued while serve was **down**.)

Ingress (submissions → extends → control) now drains once before the
reconcile-first tick as well, as a single ordered unit. **The order is
load-bearing:** draining control alone is the obvious fix and it silently breaks a
cancel that arrives in the same batch as its own run, because `cancelRun` on a run
the store has never seen iterates an empty item list and returns *without throwing*
— so the envelope is acked and destroyed against a run that lands moments later.
(`closeRun` throws on an unknown run, so it survives; the two diverge here.) Both
directions are pinned by tests.

*Operator note for the upgrade — checked, not assumed.* Work sitting `ready` on a
queue this stack did not previously drive becomes dispatchable on the first start
after the upgrade, so it is worth deciding about beforehand; a cancel queued in
advance is now honoured before anything fires.

**For this stack specifically, there is nothing to decide.** Queried against the live
serve DB on 2026-07-31: `gated` holds two items, both already
`cancelled (operator cancelled)`, and **no item in any queue is in a non-terminal
state**. Nothing thaws on upgrade. The query, for anyone repeating it:

```bash
docker exec pangolin-serve node -e "
const D=require('/workspace/node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3')('/data/pangolin.db',{readonly:true});
console.log(D.prepare(\"SELECT queue,status,COUNT(*) n FROM items GROUP BY queue,status\").all());
"
```

There is no client-side way to ask this — enumerating runs needs the `listRuns()`
that issue 6's deferred `listPrefixes` would unblock, which is exactly why the check
has to go through the serve container's DB.

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

What makes this worse than a normal misconfiguration: the config is *valid*. The
orchestrator accepts the queue, so there is no startup warning and no obvious place
to look.

> **Correction (2026-07-31).** This section originally claimed a second aggravating
> factor — that "**`orch cancel` cannot rescue it**, [because] cancellation is
> processed by the same tick loop, so a run stranded on an unticked queue cannot be
> cancelled either," leaving no exit but to abandon the run id. **That is wrong, and
> the live stack disproves it.** The two `gated` items in the serve-stack DB are
> `status=cancelled, reason=operator cancelled` — cancelled while `gated` was never
> being ticked.
>
> `cancelRun` is not queue-scoped. The serve loop drains control envelopes in its
> **body** and only then calls `tick(queue)`; `cancelRun(runId)` walks
> `store.getItems(runId)` and flips `pending`/`ready` straight to `cancelled` without
> ever consulting a queue. So cancel has always worked on a stranded run, provided
> serve was up to poll for it.
>
> This also downgrades the severity argued above: there *was* an exit, and it was the
> obvious one.
>
> One real cancel gap did exist, and it is a different one: a cancel queued while
> serve was **down** lost the race to the reconcile-first tick, which fired before the
> first `pollControl`. That is fixed — see the second follow-up under issue 7's status.

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

---

# Issues 8–12: the client / Fargate dispatch path

**Different provenance, and a different reader again.** Issues 1–7 came from running
`deploy/serve-stack`. These five came from building the **consumer** side — ai-os
wiring `pangolin-client` to `FargateProvider` for live dispatch — and none of them
involves `serve`, the orchestrator, or the audit chain. They are filed here because
this is the only known-issues file in the repo; they belong to `pangolin-client`,
`pangolin-secret-store`, `pangolin-providers-fargate`, and `pangolin-worker`.

**Provenance, stated plainly: these are read from source, not reproduced at
runtime.** ai-os has not yet dispatched — that is the slice this work is preparing —
so nothing below carries a measurement the way issue 6 does. Every claim is a
`file:line` on `main` at `b0063b4`, and each was cross-checked against the published
`0.4.0` dist so it is not a main-only artifact. Treat the impact estimates as
reasoned rather than observed, and 8 in particular deserves a reproduction before
anyone acts on it.

> **Update 2026-07-31.** Issue 8 got that reproduction, and it is worth reading as a
> verdict on this whole section's method. The defect was real and reproduced. But its
> stated *mechanism* did not reproduce (MinIO returns 404 where the entry predicts
> 403), and its suggested *fix* named an unexported function. Both errors survived the
> "independently verified against source" pass below, because that pass checked that
> the cited code says what the entry claims — which is a different question from
> whether the entry's reasoning about it holds. The remaining source-only entries
> (9–12) should be read with that gap in mind.

*Independently verified against source, 2026-07-31 — all five hold.*

- **8** — `markerPresent` is verbatim as quoted, and the suggested `isNotFound`
  predicate does exist in `pangolin-storage-s3`.
  *Amended 2026-07-31 (issue 8's fix):* "exists" was checked; **"is usable" was not**.
  `isNotFound` is module-private, so the suggested fix could not have been written as
  described. The exported, contract-level predicate is `isStorageNotFound` in
  `pangolin-core`. A grep confirming a symbol exists does not confirm it is reachable —
  which is the same class of near-miss this section was congratulating itself on avoiding.
- **9** — `PANGOLIN_AGENT_TIMEOUT_SECONDS` and `PANGOLIN_PLUGIN_INSTALL_TIMEOUT_SECONDS`
  appear at their emit site and **nowhere else** under `packages/*/src`, so "a consumer
  that does not exist" holds as written.
- **10** — `stage()` does mint via `CreateSecretCommand` and return `res.ARN`, and
  `fireWork` names secrets `${dispatchId}/${envName}` (`dispatch.ts:179`). The
  six-random-character ARN suffix is documented Secrets Manager behaviour.
- **11** — `RunTaskCommand`'s `overrides` carries only `containerOverrides`
  (environment + command). No `taskRoleArn` appears anywhere in the package, so the
  role comes from the shared task definition. The suggested fix is sound: ECS *does*
  support `overrides.taskRoleArn`, so this is unused capability rather than a platform
  limit.
- **12** — `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` are set and
  neither touches repo-local `.git/config`. The entry's calibration is right too: the
  credential lane really is already closed by the v0.3.1 allowlist, so what remains is
  code execution rather than exfiltration.

Worth recording that this section survived checking intact, because four separate
claims elsewhere in this file did not when tested the same day. A `file:line` citation
is a good reason to look, not a reason to believe — and here, looking confirmed it.

---

## 8. `markerPresent` swallows every error, so the dedupe guard can silently be off

**Status: FIXED — reproduced first, and the reproduction corrected two claims below.**

This entry asked for a reproduction before anyone changed `fireWork`. That was the
right instinct, and it paid: the defect is real and now has a runtime reproduction,
but **the specific mechanism argued for below does not reproduce on this stack**, and
the suggested fix pointed at the wrong predicate.

*The defect reproduces, against real MinIO through the real `S3StorageProvider`.*
An identity holding `s3:PutObject` but not `s3:GetObject` reads a marker that
demonstrably exists:

```
1. marker WRITTEN by root (the "first fire")
2. markerPresent(root)      => true   (expected true)
3. writeonly.get            => throws name=AccessDenied status=403
     is it StorageNotFoundError? false
4. markerPresent(writeonly) => false   (expected true; GUARD IS OFF)
```

Step 4 is the bug entire: the marker is present, and the guard reports "not fired".
`fireWork` would re-stage the callback HMAC key and run a second container.

*Correction 1 — **MinIO does not exhibit the 403-on-missing-key behaviour**, so the
sharp case argued below is not locally reproducible.* The claim is that S3 returns
403 rather than 404 for `GetObject` on a *missing* key when the caller lacks
`s3:ListBucket`. That is documented **AWS** behaviour, and it is why a mis-scoped role
is a *permanent* silent no-op rather than a transient one — but MinIO returns
`NoSuchKey`/404 in that case. Measured, with the policy confirmed live and narrow
(same user, same bucket):

| probe as a user with `GetObject`+`PutObject` on `bucket/*`, no `ListBucket` | result |
|---|---|
| `ListObjectsV2` | `AccessDenied` **403** (so the scoping is genuinely in force) |
| `GetObject`, key present | OK |
| `GetObject`, key **missing** | `NoSuchKey` **404** — *not* the predicted 403 |

So a MinIO-based test of *that* mechanism would have passed for the wrong reason and
given false confidence. The reproduction above reaches a real 403 by a different
mis-scoping (no `GetObject` at all), which is at least as easy to write.

This does not weaken the issue. The 403 detail was only ever one of four errors the
bare `catch` swallowed, and the defect does not depend on it — a network fault or a
throttle disarms the guard identically. It does mean the *urgency* argument ("easy to
reach, permanent") rests on AWS behaviour that this dev topology cannot demonstrate.

*Correction 2 — the suggested predicate is the wrong one, and a better one already
exists.* The fix below names `isNotFound` in `pangolin-storage-s3`. That function is
**module-private** — not exported — so it could not have been used as described.
`pangolin-core` already exports the contract-level predicate `isStorageNotFound`
(`errors.ts:104`), and `StorageProvider.get` is contractually required to throw
`StorageNotFoundError` (`storage.ts:19`, "never return a sentinel value"). The S3 and
local providers both honour that, so the s3-internal predicate was never needed:
`isNotFound` is what *builds* the typed error, not what callers should read.

Better still, the idiom was already in the same package. `readDispatchRecord`
(`retention.ts:86`) reads the *same* `dispatches/<id>/` prefix through the *same*
`client.storage` and does exactly the right thing — `if (isStorageNotFound(err))
return null; throw err;` — with a test pinning that a generic `/not found/i` *message*
must not be mistaken for absence. `markerPresent` was the odd one out, and its own doc
comment claimed it "mirrors every other not-found convention in this file", which was
true only of the best-effort reads and false of the one that mattered.

*The fix.* `markerPresent` returns `false` only for `isStorageNotFound(err)` and
rethrows everything else. Five tests pin it: authorization denial, transient network
error, a generic `/not found/i` message, plus both directions of genuine absence
(typed and duck-typed, since the name check is what survives duplicate package
copies).

*An existing test caught something, as usual.* Five pre-existing dedupe tests broke on
the fix — because that file's in-memory `StorageProvider` double signalled absence
with a bare `Error`, violating the contract it claimed to implement. The double was
wrong, not the fix. Worth noting the same contract-violating stub is copied across
~10 test files in `pangolin-client`; only this one was behaviourally relevant, and
unifying them is left as a separate refactor rather than smuggled in here.

*Deliberately not widened.* `readSubagentCapabilities` and env-bundle resolution in
the same file still swallow everything. Those degrade to a sane default by design;
this one decides whether to fire. Changing them is a separate judgement call.

**Original report follows.** Reported from ai-os, 2026-07-31.

**Symptom.** `dedupeOnDispatchId: true` appears to work — no error, no warning — while
providing no protection whatsoever. A re-fire of an already-fired `dispatchId` runs a
second container.

**Cause.** `packages/pangolin-client/src/dispatch.ts:520-526`:

```ts
async function markerPresent(storage: StorageProvider, uri: string): Promise<boolean> {
  try {
    await storage.get(uri);
    return true;
  } catch {
    return false;
  }
}
```

The bare `catch` cannot distinguish *"the marker is absent"* — the answer it wants —
from *"I am not authorised to look"*, *"the network failed"*, or *"S3 throttled me"*.
All four return `false`, which `fireWork` reads as "not yet fired, proceed".

The authorisation case is not hypothetical, and it is the one that persists. S3
returns **403 rather than 404** for `GetObject` on a missing key when the caller lacks
`s3:ListBucket` on the bucket — so a dispatch role scoped to `GetObject`/`PutObject`
but not `ListBucket` is a *permanently* silent no-op, not a transient one. That
mis-scoping is easy to reach: `ListBucket` is granted on the **bucket** ARN while the
object actions are granted on `bucket/*`, so writing the policy in the obvious way
omits it.

**Impact.** A guard that silently stops guarding — the same class as issues 5a and 6b
in this file, and the reason both were treated as real. Here the consequence is
duplicate dispatch: two containers for one `dispatchId`, both writing
`dispatches/<id>/output.json`, and the second's callback HMAC key replacing the
first's mid-run (which is precisely what the step-0 comment says the guard exists to
prevent).

**Suggested fix.** Let the not-found case be the only one that returns `false`.
`pangolin-storage-s3` already has the predicate — `isNotFound`
(`packages/pangolin-storage-s3/src/index.ts`, used by `readIndexWithEtag`) — so the
shape is `catch (err) { if (isNotFound(err)) return false; throw err; }`, with the
predicate reached through the `StorageProvider` contract rather than imported
directly. Rethrowing turns a mis-scoped policy into a loud failure at the first
dispatch instead of a guarantee that quietly does not hold.

If rethrowing is judged too strict for a guard that is opt-in, the weaker fix is to
take a logger and warn on any non-not-found error before returning `false` — but note
that `fireWork` has no logger today, which is itself part of why this is invisible.

---

## 9. Two timeout env vars are emitted to a consumer that does not exist

**Status: FIXED — honoured, not deleted. The suggested fix would not have worked.**

Every claim in this entry verified. Both variables are emitted and read nowhere;
`envSecondsOr` exists **only inside the comment that names it**, in `src` and in the
published `dist` alike; the adapter contains no `setTimeout`, no `AbortSignal` and no
`kill(`. It was a fiction described as a safety net.

*But the suggested fix was wrong, and wrong in a way that matters.* It says to "read
`PANGOLIN_AGENT_TIMEOUT_SECONDS` in the adapter". **The adapter cannot see it.** The
worker's `filterRuntimeEnv` is a DEFAULT-DENY allow-list, and `PANGOLIN_*` is not on
it — deliberately, since the firewall exists precisely to keep control-plane vars
(including the callback HMAC key reference) away from a prompt-injected sub-agent.
Measured, rather than reasoned:

```
worker process.env (what the client emitted):
  PANGOLIN_AGENT_TIMEOUT_SECONDS, PANGOLIN_PLUGIN_INSTALL_TIMEOUT_SECONDS,
  PANGOLIN_CLAUDE_PERMISSION_MODE, PATH
survives into adapter ctx.env:
  PATH
```

So implementing this entry as written produces a bound that is *always* the adapter's
own default and never the caller's `timeoutSeconds` — a fix that reads correct,
passes a naive test, and silently does nothing. That is the same failure mode as
issue 8, reached by following this file's own advice. It was caught only by checking
where the value actually travels rather than trusting the citation.

*What landed instead.* The bounds are threaded **explicitly** on `RuntimeContext`
(new optional `agentTimeoutSeconds` / `pluginInstallTimeoutSeconds`), parsed by
`parseWorkerEnv` from the worker's own process env — where a TaskSpec env var
actually lands. That is not an invention: `PANGOLIN_SETUP_TIMEOUT_SECONDS` already
takes exactly this route into `cfg.setupTimeoutSeconds`. Enforcement is SIGTERM then
SIGKILL after a grace period; a timed-out agent resolves 124 with a reason on stderr
(preserving the partial transcript), a timed-out plugin install throws naming the
plugin. Defaults are 7200/300 and apply even when unset — an absent bound means the
default, never "unbounded".

Allow-listing the two names in the env firewall was the one-line alternative and was
rejected: it widens a security boundary for a non-security reason and puts
control-plane values in the sub-agent's environment, which is the exact thing the
firewall was built to prevent.

> **Separate finding, surfaced by this work and NOT yet fixed.**
> `PANGOLIN_CLAUDE_PERMISSION_MODE` is stripped by the very same firewall — see the
> measurement above. `resolveBypassFlag` reads it from `ctx.env`, so unless an
> operator routes it through an env bundle or `PANGOLIN_RUNTIME_ENV_ALLOW`, it is
> never seen and the adapter always takes the `bypass` branch. `strict` mode is
> documented in `docs-site/.../dispatch-lifecycle.md` as reading "the dispatch's
> merged env" and is offered for "read-only / analytical dispatches that should make
> no filesystem or process changes" — a safety control that may be silently inert as
> documented. This needs its own reproduction before anyone acts on it, exactly as
> issue 8 asked for; it is recorded here rather than fixed in passing because a
> permission control deserves its own change and its own tests.
>
> **Update: reproduced and fixed — see issue 14.** It did fail open. The
> two-stage reproduction (real worker lifecycle, then the real adapter) is
> recorded there, along with the correction that it was never categorically
> inert: two undocumented routes worked, and it was the obvious one that
> silently did not.

**Original report follows.** Reported from ai-os, 2026-07-31.

**Symptom.** A dispatch carrying an explicit `timeoutSeconds` runs unbounded. The
agent can hang indefinitely; on Fargate that burns billed compute until someone
notices.

**Cause.** `packages/pangolin-client/src/dispatch.ts:315-321` emits two variables and
explains itself by naming a reader:

```ts
// Emit derived worker-side timeout bounds (R4). With the 7200s floor always
// defined, these are always emitted. The adapter's envSecondsOr defaults
// remain a safety net for any older/standalone worker image that doesn't
// receive them.
if (effectiveTimeoutSeconds !== undefined) {
  envVars.PANGOLIN_AGENT_TIMEOUT_SECONDS = String(effectiveTimeoutSeconds);
  envVars.PANGOLIN_PLUGIN_INSTALL_TIMEOUT_SECONDS = String(...);
}
```

There is no such reader. Three greps over `main` at `b0063b4`:

| grep | result |
|---|---|
| `PANGOLIN_AGENT_TIMEOUT_SECONDS\|PANGOLIN_PLUGIN_INSTALL_TIMEOUT_SECONDS` over `packages/*/src/` | only the three lines above |
| `envSecondsOr` over `packages/*/src/` | only the comment above |
| every `PANGOLIN_*` string in `pangolin-runtime-claude-code@0.4.0/dist` | exactly two: `PANGOLIN_CLAUDE_PERMISSION_MODE`, `PANGOLIN_DISABLE_NEEDS_INPUT_HELPER` |

`parseWorkerEnv` (`packages/pangolin-worker/src/env-parser.ts`) reads
`PANGOLIN_SETUP_TIMEOUT_SECONDS` but neither of these, and `claude-spawn.ts` contains
no `setTimeout`, no `AbortSignal`, and no `kill(`. So the values travel into the
container and are read by nothing.

**Impact.** Two layers, and the second is why this is worth filing rather than
deleting the lines.

The direct cost is an unbounded agent. `boundedAwaitExit` **does** exist and **does**
bound — but only on the `awaitExit` path, which a fire-and-forget consumer never
calls. For those consumers there is no bound anywhere in the stack: not in the client,
not in the worker, not in the runtime adapter, and `FargateProvider.run` sets no ECS
limit either (ECS has no native per-task timeout).

The larger cost is that the comment asserts a safety net that is not there. A consumer
reading `dispatch.ts` concludes the timeout it passes is enforced worker-side, and
builds on that. That is exactly what happened here — it took three greps to establish
otherwise, and the natural reading of the code is the wrong one.

**Suggested fix.** Either honour it or stop advertising it. Honouring it is
preferable and belongs in `pangolin-runtime-claude-code`: read
`PANGOLIN_AGENT_TIMEOUT_SECONDS` in the adapter and enforce it around `spawnClaude`
with a `SIGTERM`-then-`SIGKILL` escalation, so a hung agent produces a *failed*
pipeline with a reason rather than a container that never exits. The same treatment
for `PANGOLIN_PLUGIN_INSTALL_TIMEOUT_SECONDS` in `plugin-installer.ts`.

If enforcement is out of scope, delete the emission and the comment — an env var with
no consumer is worse than no env var, because it reads as a contract.

**Note on scope.** Even with this fixed, an agent-phase timeout does not bound the
*task* — bundle fetch, plugin install, capture, and callback all sit outside it. A
consumer running on Fargate still needs its own task-level bound, and ai-os is
shipping one. That is not an argument against fixing this; it is the reason the two
are separate concerns.

---

## 10. `AwsSecretStore.stage` returns a random-suffixed ARN, so callers cannot scope IAM

**Status: FIXED as a declared contract — but the symptom below is WRONG.**

*The cause is accurate; the symptom it is used to argue for is not.* `stage()` does
mint via `CreateSecret` and return `res.ARN`, and Secrets Manager does append six
random characters. But the symptom — "a caller wanting least-privilege on staged
secrets has no policy to write except a wildcard over the whole namespace" — does not
follow, and is false.

**The names are deterministic given `dispatchId`**, and `dispatchId` is caller-
suppliable on `DispatchWork`:

| secret | name |
|---|---|
| inline per-dispatch secret | `<dispatchId>/<envName>` |
| callback HMAC key | `pangolin/callback-hmac/<dispatchId>` |

So `secret:<dispatchId>/*` was writable all along. **The random suffix was never the
blocker** — an IAM resource wildcard covers exactly that, which is why every
least-privilege pattern for Secrets Manager ends in `*` anyway. The entry reasons from
"the ARN is unpredictable" to "therefore the policy must be namespace-wide", and that
step does not hold.

*What was actually missing was a promise.* The naming was an undeclared internal
convention — correct, stable, and discoverable only by reading `dispatch.ts:179` and
`callback-hmac.ts:23`. A caller scoping IAM against it was coupling to an
implementation detail with a silent failure mode, which is the same complaint issue 13
makes about the undeclared `inputs.*` carriers.

*The fix is therefore a contract, not an API.* `dispatchSecretName`,
`callbackHmacSecretName`, `CALLBACK_HMAC_NAME_PREFIX` and
`dispatchSecretPolicyPatterns` are now exported from `pangolin-client`, and the
dispatch path builds its names through the same helpers with a test pinning that — so
the published contract cannot drift from what is actually staged.
`dispatchSecretPolicyPatterns(dispatchId)` returns the two patterns covering one
dispatch (two, because the inline secrets and the callback key share no prefix), and a
test asserts they do **not** match a sibling dispatch's key.

The suggested `stage({ deterministicName: true })` / `PutSecretValue` path was **not**
built: it solves ARN predictability, and ARN predictability was not the problem. Noted
rather than silently skipped, because the reasoning is the reusable part — the fix that
looked necessary was downstream of a premise that did not survive checking.

**Original report follows.** Reported from ai-os, 2026-07-31.

**Symptom.** A caller wanting least-privilege on staged secrets has no policy to
write except a wildcard over the whole namespace.

**Cause.** `packages/pangolin-secret-store/src/aws-secret-store.ts:39-53` stages via
`CreateSecret` and returns `res.ARN`. Secrets Manager appends **six random
characters** to every secret ARN it mints, and that suffix is unknowable at
policy-authoring time. Since `fireWork` names secrets `${dispatchId}/${envName}` and
`dispatchId` is a fresh uuid per dispatch, the ARN is unpredictable on both segments.

**Impact.** The tightest writable policy a caller can author is
`arn:aws:secretsmanager:…:secret:<prefix>/*`. On a substrate where the task role is
shared across dispatches — see issue 11 — that grant reaches **every** dispatch's
staged secrets, including every dispatch's callback HMAC key. A compromised run can
read the key that authenticates another run's callback.

Both halves are needed for that consequence, which is why these are filed as a pair.

**Suggested fix.** Offer deterministic paths. `PutSecretValue` against a
pre-created secret, or an opt-in `stage({ deterministicName: true })` that creates
under a caller-supplied stable name, would let a caller scope to
`secret:<prefix>/<dispatchId>/*` — still a wildcard, but one bounded to a single
dispatch, which is the boundary that matters.

Worth noting `CreateSecret` also throws `ResourceExistsException` on a name collision,
so a deterministic path needs a create-or-update, not a bare create.

---

## 11. `FargateProvider` has no per-dispatch task role, so every dispatch shares one identity

**Status: FIXED.** This entry was right, including its diagnosis that the gap was
unused capability rather than a platform limit. Checked against the installed SDK
rather than taken on trust: `TaskOverride` really does carry `taskRoleArn`.

`FargateProviderOpts.taskRoleArn` is now passed through to
`overrides.taskRoleArn` — a string for a fixed role, or a resolver
`(spec) => string | undefined` to vary it per dispatch, since `TaskSpec` carries
`dispatchId`. Callers that set nothing keep today's behaviour exactly: the field is
omitted from the override entirely rather than sent as `undefined`, and a test pins
that.

It is deliberately **not** on `TaskSpec`. That contract is provider-agnostic and shared
with the local Docker provider, and an IAM ARN is an AWS concept; keeping it on the
provider's own options confines AWS to the AWS package.

*One correction.* The entry justifies leaving the execution role alone with "only the
task role is overridable". That is false — `TaskOverride` exposes `executionRoleArn`
too. The *recommendation* still stands, for the reason the entry gives second and which
is the real one: the execution role pulls images and writes logs, so it is
infrastructure rather than workload identity, and varying it per dispatch would break
task launch rather than scope anything. A test asserts the provider never sets it.

*On the pair.* With per-dispatch roles available, the joint consequence 10 and 11 were
filed for — a compromised run reading another run's callback HMAC key — is closable
today: mint a role per dispatch and scope it with
`dispatchSecretPolicyPatterns(dispatchId)`. Note that this is a capability now offered,
not a default; a caller that keeps one shared role still has one shared identity.

**Original report follows.** Reported from ai-os, 2026-07-31.

**Symptom.** Every dispatch on a given target runs with identical AWS permissions,
regardless of what it was asked to do.

**Cause.** `packages/pangolin-providers-fargate/src/index.ts` runs a single
`taskDefinitionFamily` and its `RunTaskCommand` sets `overrides.containerOverrides`
only — `environment`, `command`, `cpu`, `memory`. There is no `taskRoleArn` anywhere
in the package (`grep -rn "taskRoleArn\|taskRole" packages/pangolin-providers-fargate/src/`
returns nothing), and the task role is therefore whatever the task definition was
registered with.

ECS itself does support this: `RunTask` accepts `overrides.taskRoleArn`. The gap is
that the provider does not expose it.

**Impact.** Per-dispatch S3 or secret scoping is impossible on this substrate. A
low-trust dispatch and a high-trust one get the same credential. Combined with issue
10's wildcard, the blast radius of a single compromised run is every staged secret in
the namespace.

This also sits awkwardly against the care taken elsewhere in the stack — the env
firewall, content-addressed bundles, and the digest pin all work to bound what a
dispatch can do, and then the credential is shared.

**Suggested fix.** Add an optional `taskRoleArn` to `TaskSpec` (or to the
per-dispatch options that build it) and pass it through to
`overrides.taskRoleArn`. Callers that do not set it keep today's behaviour exactly.
The task *execution* role must stay on the task definition — only the task role is
overridable — which is the right split anyway, since the execution role is
infrastructure and the task role is workload identity.

---

## 12. `buildGitEnv` neutralises global and system git config, but not repo-local

**Status: FIXED for the known directives — still a partial, and deliberately so.**

The entry's calibration was right on every point, including its restraint. The
credential half really is closed (`buildGitEnv` is a genuine allowlist, and a static
test pins its exact key set); what survived was code execution as the worker, from
content inside the repository being operated on.

*It was already reproduced in-tree, which the entry did not mention.*
`patch-capture-escape.test.ts` planted a repo-local `core.fsmonitor` hook and asserted
it **ran** — using it as a live probe that `buildGitEnv` withholds credentials. So the
execution half had a working demonstration all along; it was simply being used to prove
a different property.

*The fix.* `git()` already threads `-c` flags, and `-c` beats repo-local config, so the
hardening lands in one place: `core.fsmonitor=false`, `core.pager=cat`,
`core.hooksPath=/dev/null`, plus `--no-ext-diff --no-textconv` on the diff. The last two
are flags rather than `-c` because `diff.external` and `diff.<driver>.textconv` are
per-driver and enabled through the repo's own `.gitattributes` — no single `-c` disables
them.

The escape test now asserts the hook does **not execute at all**, which is strictly
stronger than "executes but sees no credential". Its sibling — a raw `git` with no
scoping — still fires the same hook and still leaks, so the new absence is the flags
doing work rather than a vector that quietly stopped being live.

*What remains open, stated plainly.* `filter.<driver>.clean` still executes on
`git add -A` when the repo's `.gitattributes` declares it. It is per-driver, so like
textconv it cannot be turned off with one `-c`, and unlike textconv there is no
equivalent flag on `add`. **The general answer remains the entry's first suggestion:
relocate `GIT_DIR` to a copy of the repo metadata outside the workspace.** That is a
restructure, it is not urgent for a consumer whose workspace holds only its own trusted
source, and it is recorded here rather than half-done.

So this is still correctly filed as a partial — a smaller one, with the cheap directives
closed and the remaining hole named rather than implied.

**Original report follows.** Reported from ai-os, 2026-07-31.

**Cause.** `packages/pangolin-worker/src/patch-capture.ts:61-62` sets:

```ts
GIT_CONFIG_GLOBAL: '/dev/null', // kills ~/.gitconfig and $XDG_CONFIG_HOME/git/config
GIT_CONFIG_NOSYSTEM: '1',       // kills /etc/gitconfig
```

Both are correct and effective. What is absent is any relocation of `GIT_DIR`, so a
**repo-local** `.git/config` is still read — and directives such as `core.fsmonitor`,
`core.pager`, and `diff.*.textconv` execute arbitrary commands from it.

**Impact.** Bounded, and worth stating precisely rather than alarmingly. The
credential half is already closed: the hook runs with no `AWS_*` in its environment,
because `buildGitEnv` is a genuine allowlist. What survives is code execution as the
worker during patch capture, from content inside the repository being operated on.

For a consumer whose workspace contains only its own trusted source this is
approximately theoretical. It stops being theoretical for any consumer that captures
patches against a repository it does not control — which is the case a
review-before-merge gate exists for, since the tampering would run during the very
step meant to inspect it.

**Suggested fix.** Point `GIT_DIR` at a copy of the repo metadata outside the
workspace, or add `-c core.fsmonitor=false -c core.pager=cat` to the capture
invocations. The second is cheaper and closes the known directives without
restructuring; the first is the general answer.

---

---

# Issue 13: evaluation and input pinning

**Filed separately from 8–12, and it does not belong to that group.** Those five came
from wiring `pangolin-client` to `FargateProvider` for live dispatch. This one comes
from trying to *evaluate* a subagent rather than run it, and it is a feature request
rather than a defect. It was sitting in the working tree during the issue-6 work and
was swept into #128 by a `git add` on this file — so it landed on `main` under a commit
message about `listRuns`, which mentions none of it. Recorded here because the commit
history is now misleading on that point and cannot be un-misled.

---

## 13. No supported way to mount an immutable input artifact independent of subagent identity

**Documented limitation, not a request. Nobody is blocked on it.**

Filed because the analysis cost most of a day and the next person who tries to
evaluate a pangolin subagent will hit exactly this — not because anything is
waiting on a fix. The consumer that found it measured what it needed through a
deliberately-labelled *simulated* boundary and then stopped: the question it was
chasing turned out to be answerable by six hand-read trials, and the apparatus
that would have consumed this feature was never built.

**No urgency is claimed and no roadmap should move for it.** The shapes suggested
below are conditional — *if* this is ever addressed, they are what a consumer
would need — rather than a design being asked for.

Two things here stand on their own regardless of what is decided about the
feature:

1. **The missing third identity** (end of this entry). Pangolin records agent
   build identity and capability identity independently, and has no notion of
   trial input identity. Every symptom below follows from that one absence.
2. **Five undeclared plan-level carriers**, one of them explicitly
   *"Shape guard (not trust guard)"*.

On (2), stated carefully: the carriers are undeclared on `WorkItem` and
unvalidated at submit. Whether a submitter-supplied ref pointing outside the run
is rejected **downstream** is unverified from outside — `assertArtifactRef` does
guard the fetch on the paths that were read. That is a question worth answering,
not a vulnerability claim.

**Verified against source, 2026-07-31 — every claim holds, and one is understated.**

| claim | check |
|---|---|
| `WorkItem.inputs` is `Record<string, unknown>` | `contracts/types.ts:52` ✓ |
| `fire()` reads `inputs.inputRefs` / `pipeline` / `env` off the item | `executors/dispatch.ts:59,72,93` ✓ |
| `tick` leaves a submitter-set `inputs.inputRefs` alone when `needs` is empty | `engine/tick.ts:159` ✓ |
| the subagent hash covers `(name, systemPrompt, promptTemplate, model, capabilities)` | ✓ |
| `registerEnv` is public, typed, content-addressed to `EnvRef`, and **absent** from that hash | ✓ |
| `needs` can only bind to an upstream item's product | `engine/needs-resolver.ts` ✓ |

The central argument therefore stands: `registerEnv` is exactly the shape being asked
for, one type over — the combination of *content-addressed* and *not part of subagent
identity* is precisely what lets identity and input vary independently, and it exists
for environment variables with no artifact-typed sibling.

**Understated: there are FIVE undeclared carriers, not three.** `fire()` also reads
`item.inputs.subagent` (`:51`) and `item.inputs.workerInput` (`:94`), neither declared
on `WorkItem` either. That strengthens the ask rather than weakening it — the two extra
carriers are *agent identity* and *the instruction payload*, which are the ones most
worth having typed. A reader currently discovers all five by grepping the executor.

**Symptom.** A dispatch's workspace input cannot be fixed without also changing
the subagent's identity. That makes controlled evaluation of an agent impossible:
you cannot hold the agent constant and vary only what it is looking at, which is
the one thing an experiment needs to do.

Concretely, measuring how often a verifier subagent accepts a patch that does not
satisfy its criterion requires the *same* verifier to see *byte-identical* patches
across trials. Today that cannot be arranged.

**Cause.** There are exactly two routes for getting a file into a dispatch
workspace, and each rules the case out:

1. **`needs`** (`contracts/types.d.ts:33`, resolved at
   `engine/needs-resolver.js:12-24`) binds an input key to an *upstream item's*
   product. The artifact must therefore be produced by another dispatch in the
   same run — so it is agent-generated and varies per trial. Fixing the input this
   way is impossible by construction.

2. **Capabilities** place files at their literal workspace paths, which *can*
   deliver a fixed artifact — but `subagent.register` hashes the capability set
   into the subagent definition
   (`pangolin-client/dist/subagent-register.js:38-49` hashes
   `{name, systemPrompt, promptTemplate, model, capabilities}`). Binding a fixture
   capability therefore mints a different subagent. Re-registering under the
   production name to avoid that would replace the production agent for every
   future dispatch.

So identity and input cannot be varied independently. An evaluation harness is
forced to compare a *reconstructed* boundary against production and enumerate the
divergence, rather than measuring production directly.

**This is a half-finished pattern, not a missing concept.** Two things in the
codebase already do most of what is being asked for.

**(a) Three undeclared plan-level carriers already share one posture.**
`executors/dispatch.js` `fire()` reads all three straight off `item.inputs`:

| carrier | handling in `fire()` |
|---|---|
| `inputs.env` | passed through to `dispatch.fire` |
| `inputs.pipeline` | shape-guarded, commented *"matching the inputRefs posture"* |
| `inputs.inputRefs` | shape-guarded — **"Shape guard (not trust guard)"** |

None is declared on `WorkItem`, which types `inputs` as
`Record<string, unknown>` (`contracts/types.d.ts:24`), and none is validated at
submit. The pipeline carrier's own comment names `inputRefs` as the reference
posture it was written to match — so this is an established internal convention,
which is precisely why it should be a declared one.

`engine/tick.js:132` guards its overwrite on `it.needs && Object.keys(it.needs).length > 0`,
so an item with **no `needs`** is left untouched and a submitter-set
`inputs.inputRefs` reaches the worker as-is.

**(b) `registerEnv` is the shape this wants, one type over.** It is public,
typed, documented, content-addressed to an `EnvRef`, idempotent, and — critically
— **selectable per run through `inputs.env` without being hashed into the
subagent definition**. That is exactly the independence evaluation needs. It
simply carries environment *variables*; there is no artifact-typed sibling that
carries workspace *files*.

So the ask is not "add an input mechanism". It is: **finish the pattern you have
already established twice** — give the artifact case the treatment `registerEnv`
gets, and give the three carriers a declaration.

**We did not use the carrier, deliberately.** The reason is pangolin's own
sentence: *"Shape guard (not trust guard)."* The executor states it filters
non-strings and does not validate trust, and the cross-dispatch artifact-fetch
authorization behaviour for a submitter-supplied ref is unstated. Depending on
that would couple an external consumer to an undeclared internal convention whose
failure mode is silent. The ref would simply not be there, or would be someone
else's.

**Shape it would need, if ever addressed.** Not a request — see the header. Written
down so the requirements are not rediscovered alongside the problem:

```ts
// contracts/types.d.ts
export interface WorkItem {
  /** Literal artifact refs mounted at `inputs/<key>`, independent of `needs`.
   *  Validated at submit; refs must resolve and be authorized for this run. */
  inputRefs?: Record<string, string>;
}
```

with, at minimum: rejection at submit when a ref does not resolve; an explicit
authorization rule for refs not produced within the run — the trust guard the
executor's comment says it is *not* doing; and a documented precedence when both
`needs` and `inputRefs` name the same key. Erroring is probably right, since
silently preferring one would make a wiring mistake invisible.

Declaring `env` and `pipeline` on `WorkItem` at the same time would cost almost
nothing and would remove the need for a reader to discover any of the three by
grepping the executor.

The audit story is unaffected and arguably improved: a literal ref is *more*
reproducible than one resolved from a sibling dispatch, because it is stable
across runs and can be committed alongside the plan.

**Smaller alternative, and probably the better boundary.** A `registerArtifact` /
`ArtifactRef` sibling to `registerEnv`, selectable via a declared
`inputs.artifacts`, solves the evaluation case without touching `inputRefs` or
`needs` semantics at all. `needs` means *"products of upstream items"*; a pinned
fixture means *"content the submitter chose"*. Those are genuinely different
things currently sharing one field, and separating them avoids renegotiating
handoff semantics to serve a case handoff was never about.

**The plumbing is small; the trust boundary is not.** An earlier revision of this
entry led with how little code it needs, which was the wrong emphasis — this
introduces a submitter-controlled path into a worker workspace. Whichever shape is
chosen should require:

- a **public typed plan field**, not another undeclared carrier;
- registration returning a **content-addressed input identity**;
- **per-run selection by immutable identity**;
- **digest verification before mounting**;
- a **deterministic mount location and precedence** rule;
- **rejection of path traversal** and of undeclared collisions;
- **size and file-count limits**;
- **no arbitrary host paths and no untrusted URLs**;
- input identity **recorded in the manifest and the bundle**;
- **no change to subagent or capability identity**;
- **executor refusal** when the referenced artifact is missing or mismatched.

**What this is really asking for is a third identity.** Pangolin already records
two independently and hashes them together:

```
Agent build identity      (subagent contentHash — includes capabilities)
Capability identity       (capability contentHash)
Trial input identity      ← does not exist
```

Everything above follows from that gap. Because there is no third identity, the
only way to fix an input is to fold it into one of the first two, which is why
holding an agent constant while varying what it sees is currently impossible.

**What it does and does not buy the consumer.** It lets a challenge fixture be
mounted against the *exact production agent identity*, upgrading a **simulated**
susceptibility measurement — `P(accept | injected defect class k)` — into a
**production-boundary** one. It does **not** yield exposure. Exposure is

```
Exposure = Σ_k  P(defect class k) × P(accept | defect class k)
```

and the left-hand term is prevalence, which comes from production audits,
incidents or representative sampling — not from transport. Worth stating here so
the feature is not oversold to whoever prioritises it.

**Who would want this.** Anyone evaluating a subagent rather than merely running it —
regression-testing a reviewer against known-bad inputs, measuring an acceptance
boundary, or pinning a golden input for a determinism check. All three need the
same thing: the agent held constant, the input fixed, and neither expressed
through the other.

---

### 13a. `DispatchInput.capabilities` already exists — `DispatchExecutor.fire` just never forwards it

**Narrows 13 rather than extending it.** 13 asks for a way to vary workspace input
independently of subagent identity, and reasons about what shape that might take.
For the *capability* half specifically the shape is already in the contract, and
has been since at least `0.4.0` — `dispatch.d.ts` is byte-identical between
`0.4.0` and `0.5.0`. Only the wiring is missing.

```ts
// core dispatch.d.ts:31-36 — DispatchInput
/** `capabilities` replaces the subagent's bound set; `addCapabilities`
 *  augments it. Callers typically pick one or the other, not both. */
subagent: string | SubagentRef;
capabilities?: Array<string | CapabilityRef>;
addCapabilities?: Array<string | CapabilityRef>;
```

`DispatchExecutor.fire` (`executors/dispatch.js:45-59`) passes `subagent`, `env`,
`input`, `target`, `workerImage`, `secrets`, and conditionally `model`,
`inputRefs`, `pipelineRef`, `trace`, `timeoutSeconds`. Neither capability field is
among them, so the selection is unreachable from a plan.

**Consequence for a consumer.** A plan names its subagent by bare string; that
resolves through `storage.resolveLatest`; the workspace overlay comes from the
resolved blob's own capability list. So changing a worker's workspace substrate
requires re-registering the subagent — mutating a registration shared by every
plan referencing that name. Two runs against different workspace snapshots cannot
coexist.

Sharper, and the part that is hard to notice: `resolveLatest` resolves per
*dispatch*, not per run, so a re-registration while a run is in flight can change
worker identity **between two items of the same run**. Nothing afterwards reports
it — each manifest is internally consistent and the bundle verifies intact.

**Proposed, and small.** Accept an optional `capabilities` (and/or
`addCapabilities`) on a work item's `inputs`, forward it in `fire()` with the same
conditional-spread pattern its neighbours already use, and accept the field in
`validateRun`.

The audit trail needs no change: `DispatchExecutorManifest.capabilities` already
records the resolved `{name, contentHash}` set per dispatch, and `manifestRef` is
sealed by `canonEntry`. A per-item override is captured by existing machinery.

**Not blocking.** The consumer that found this works around it with immutable
per-snapshot capability names plus per-cycle subagent registrations, which
preserves reproducibility at the cost of a registry that grows with cycles. Noted
because 13's "if this is ever addressed" framing reads as a design problem, and
for this half it is a wiring problem.

---

# Issue 14: a safety control that failed open

**Different provenance again.** This one was not reported by a consumer. It fell
out of the issue-9 work, when measuring where a `PANGOLIN_*` variable actually
travels turned up a second variable taking the same doomed route — one that
happens to be a security control.

---

## 14. `PANGOLIN_CLAUDE_PERMISSION_MODE` was stripped by the env firewall, so `strict` was silently ignored

**Status: FIXED — and unlike 8–13, this one was reproduced before it was written up.**

**Symptom.** An operator sets `PANGOLIN_CLAUDE_PERMISSION_MODE=strict` to run a
read-only dispatch. The dispatch runs with `--dangerously-skip-permissions`
anyway. No error, no warning, and no observable difference from having set
nothing at all.

**Cause.** The worker's `filterRuntimeEnv` is DEFAULT-DENY and `PANGOLIN_*` is
not on its allow-list — deliberately, since the firewall exists to keep the
callback HMAC key reference and the worker's identity away from a
prompt-injected sub-agent. But `resolveBypassFlag` reads permission mode out of
the adapter's `ctx.env`, which is the *post-filter* env. So the variable was
withheld from the one component that consumes it, and `resolveBypassFlag` saw
`undefined` and fell back to `bypass`.

**Reproduced, in two stages, before any fix.** Stage 1 drove the real worker
lifecycle (`runWorker`, real `LocalStorageProvider`) with a recording adapter
that dumped the `ctx.env` it was handed:

| route | reaches the adapter |
|---|---|
| set on the worker's own env — the natural operator path | **`undefined` — stripped** |
| worker env + `PANGOLIN_RUNTIME_ENV_ALLOW` | `strict` |
| delivered via an env bundle | `strict` |

Stage 2 fed exactly that env to the real `ClaudeCodeRuntimeAdapter` with only
the spawn mocked:

```
stripped (as measured) -> dangerouslySkipPermissions = true
strict arrives         -> dangerouslySkipPermissions = false
```

**Impact.** A safety control that fails **open**. The fallback is the same
`bypass` an operator who configured nothing would get, so "I asked for strict"
and "I asked for nothing" were indistinguishable — including to the operator.
The docs offer `strict` for "read-only / analytical dispatches that should
produce text but make no filesystem or process changes"; that promise did not
hold on the documented-by-implication path.

Worth being precise about the severity rather than inflating it: two working
routes existed (`PANGOLIN_RUNTIME_ENV_ALLOW`, and env bundles), neither
documented. So this was never categorically inert — it was *the obvious way*
being silently ineffective while two undocumented ways worked.

**The fix.** A short, explicitly-named set of non-credential **adapter config**
vars now passes the firewall (`BUILTIN_ALLOW_ADAPTER_CONFIG`):
`PANGOLIN_CLAUDE_PERMISSION_MODE` and `PANGOLIN_DISABLE_NEEDS_INPUT_HELPER`.

By exact name, **never by a `PANGOLIN_` prefix rule** — that would be the lazy
fix and it would hand `PANGOLIN_CALLBACK_TOKEN_REF` to the sub-agent, re-opening
the whole firewall. A test pins that specifically, so the shortcut cannot be
taken later. The blanket "drops all `PANGOLIN_*`" assertion was replaced with a
credential-by-credential one covering more vars than before, so narrowing the
claim did not narrow the protection.

Pinned at the **lifecycle** level, not only on `filterRuntimeEnv`. The unit test
alone would never have caught this: the filter was not misbehaving, it was doing
exactly what it was told. The bug lived in the gap between two components that
each looked correct in isolation — which is why the reproduction had to run the
whole worker.

**Where this generalises.** The same shape produced issue 9: a `PANGOLIN_*`
variable emitted into the task env and read from a place it could never arrive.
Both were invisible because nothing fails when an env var is missing — a default
is used instead. Any future adapter config read from `ctx.env` needs a
lifecycle-level test, not a unit test, and any such variable needs a deliberate
decision about which side of the firewall it lives on.

*Not fixed, noticed in passing:* `isHelperDisabled` and
`getNeedsInputHelperOverlay` are exported and unit-tested but have **no
production caller**, and `cfg.disableNeedsInputHelper` is parsed by
`parseWorkerEnv` and never read. `PANGOLIN_DISABLE_NEEDS_INPUT_HELPER` is
allow-listed above so it will work once something consumes it, but today it
configures nothing. That is issue 9's pattern a third time and wants its own
look.

---

# Issue 15: the self-verify signal has nowhere to go

## 15. `VerifyOutcome` is unreachable from the audit bundle — exported by `getStatus`, absent from `getAuditExport`

**Defect-shaped, low urgency, and it looks like an omission rather than a
decision.** A worker's self-verify result reaches the run-state store and
`getStatus()`, but never enters the audit export. A client whose read path is
`audit()` — the only path that works without run enumeration (issue 7's
neighbourhood) — cannot see it at all.

**Symptom.** A subagent registered with a `VerifyConfig` runs its own
language-agnostic check (`cargo test`, `pytest`, `tsc && vitest`) over its edit.
The orchestrator records the result. A supervisor reading the sealed evidence has
no channel to learn it.

**Cause — the asymmetry.** Three values arrive together, on one return from a
single `readSentinel`:

```js
// executors/dispatch.js:125
return { status, output: result, resultRef: patchRef, verify, outputRefs };
```

All three are stored symmetrically:

```js
// engine/tick.js:81,83,85
store.setResultRef(it.id, res.resultRef);
store.setVerify(it.id, res.verify);
store.setOutputRefs(it.id, res.outputRefs);
```

Two of the three are sealed into the chain at reconcile:

```js
// engine/tick.js:93,96 — item.reconciled
...(res.resultRef  ? { resultRef:  res.resultRef  } : {}),
...(res.outputRefs ? { outputRefs: res.outputRefs } : {}),
// verify: absent
```

And two of the three reach the export:

| surface | carries `verify`? |
|---|---|
| `getStatus()` — `orchestrator.js:385` | yes: `...(i.verify !== undefined ? { verify: i.verify } : {})` |
| `getAuditExport()` — `orchestrator.js:393` | **no** — rows are `id, status, attempts, actor, resultRef?, manifestRef?, outputRefs?` |
| `AuditItemOutcome` — core `audit.d.ts:201-209` | no field to put it in |
| `AuditEntry` (sealed chain) | no field to put it in |

`verify` is the only one of the three siblings that stops at the store.

**Proposed change.** Additive, mirroring what `outputRefs` already does:

1. Add `verify?: VerifyOutcome` to `AuditItemOutcome`.
2. Include it in `getAuditExport()`'s item rows with the same conditional spread
   as its siblings.

Optionally and separately: seal it at `item.reconciled` the way `outputRefs` is.
`canonEntry` already carries the conditional-append pattern for exactly this, so
legacy entries keep serializing byte-identically. Without sealing, an exported
`verify` is readable but no more trustworthy than the rest of the untrusted export
rows; with it, "the worker's own suite passed" becomes tamper-evident.

**What is NOT being asked for.** `VerifyOutcome` staying **report-only** — "it
never changes the dispatch outcome" — is the right call and should not move. A
failing self-verify is information, not a dispatch failure. The issue is only that
the information has nowhere to go.

**Priority, honestly: low.** The consumer that found this is not unblocked by it.
Its workers receive a `git archive` of tracked files, so `node_modules/` is absent
and the suite cannot run inside a dispatch regardless — a worker-image question on
the consumer's side, not pangolin's. Filed because the export gap is in this tree,
and because the field's two siblings both made it through.

---

# Issue 16: a dispatch can succeed and lose its work

## 16. `capturePatch` omits `--binary`, so a change to any git-binary file is captured as an unappliable stub

**The most consequential of the findings this consumer has filed, because it is
the only one where a run reports success and the work is gone.**

**Symptom.** A dispatch edits a file git classifies as binary. The item reconciles
`done`, `capturePatch` returns a `resultRef`, the artifact is content-addressed
and stored, and the audit chain seals it. The patch cannot be applied and cannot
be reviewed. Nothing anywhere reports a problem.

```
$ git apply --check the-exported.patch
error: cannot apply binary patch to 'scripts/isolation-oracle.ts' without full index line
error: scripts/isolation-oracle.ts: patch does not apply

$ git apply --numstat the-exported.patch
-       -       scripts/isolation-oracle.ts        <- git's marker for binary
64      0       src/core/source-hygiene.test.ts    <- the text file in the same run, fine
```

The patch's entire record of the change is one line:

```
diff --git a/scripts/isolation-oracle.ts b/scripts/isolation-oracle.ts
index 3e7f443..cb4f231 100644
Binary files a/scripts/isolation-oracle.ts and b/scripts/isolation-oracle.ts differ
```

**Cause.** `packages/pangolin-worker/src/patch-capture.ts:37-49`:

```ts
const diff = await git(workspaceDir, [
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--cached',
  baseline.treeOid,
  '--',
  '.',
  ':(exclude).pangolin',
]);
```

No `--binary`, and no `--full-index`. Git's default for a binary path is the stub
above: a header, an abbreviated index line, and no payload.

**This is not only about images, and that is the part worth pausing on.**
"Binary" here is git's own content heuristic, and a single stray control byte is
enough to trigger it. The file in the reproduction is an 8,874-byte TypeScript
source whose only offence was two delimiter characters — `0x00` and `0x01` —
written as raw bytes instead of escapes. It reads as ordinary source in an editor.
Any repository with a `.ts`, `.py` or `.go` file containing one stray control byte
has dispatches that cannot return their work, and no way to find that out except
by trying to apply the result.

**Observed end to end**, run `loop7-ctlbytes-47738cb-1785693717`, 2026-08-02. The
task edited two files. The text one came back intact; the other came back as the
stub. The consumer's own verifier reached the right conclusion unaided —

> "the hunk in inputs/work is only 'Binary files a/… and b/… differ' with no GIT
> binary patch payload, so the patch contains no evidence of what actually
> changed"

— and failed the item. That is the correct verdict, and it is also why the
failure is easy to misattribute: it presents as a worker that did not do the job.

**Proposed fix.** Add `--binary` to that argument list. It implies `--full-index`,
so one flag covers both errors above. The output is base85-encoded ASCII, so the
existing `new TextEncoder().encode(diff)` on line 50 stays correct with no change.

If emitting full binary payloads is unwanted — a large asset would inflate the
artifact — then the alternative is to **refuse loudly rather than emit a stub**:
detect the `Binary files … differ` shape and surface it as a capture failure, so
the dispatch does not report a `resultRef` that cannot represent what happened.
Either is fine. Silently returning an unusable patch is the thing to stop.

**Why the tests do not catch it.** `packages/pangolin-worker/test/` has five
`patch-capture*` test files. Every fixture in them is text. The fixture set
encodes the same assumption as the code, so the suite is green over a path no
real binary change survives — the same shape as this file's existing
"item-status polarity" entry, where the fixture was written from the same wrong
belief as the predicate.

A regression test wants a fixture containing one control byte in an otherwise
ordinary source file, not a `.png`. The `.png` case is the one people remember to
write; the stray-byte case is the one that actually happens.


---

## 17. Dev shapes are defined, registered and schema-validated, but pinned to a placeholder image — so `dev.verify`'s "repo snapshot + patch applied" context is unreachable

**This is a feature request rather than a defect, and it asks for the last mile
of work that is already done.** `packs/dev.ts` describes exactly the verifier
context a consumer needs; one placeholder constant and one missing parameter keep
it from being dispatchable.

**What ships today.** `packages/pangolin-orchestrator/src/packs/dev.ts`:

```ts
const WORKER_IMAGE = "sha256:PLACEHOLDER"; // TODO(PR6): pin the real worker image digest before dev shapes are dispatched

export const devVerify: SubagentShape = {
  id: "dev.verify",
  effectTier: "read-impure",
  inputSchema: z.object({ patch: patchSchema }),
  outputSchema: z.object({ passed: z.boolean(), report: z.string() }),
  capability: { imageDigest: WORKER_IMAGE, permissions: {}, contextShape: "repo snapshot + patch applied" },
  inputEdgeTypes: { patch: "patch-ref" },
};
```

`engine/tick.ts` resolves a shape, validates inputs against its zod schema, and
derives the effect class from it:

```ts
effectClass = shape.effectTier; // shape-authoritative; replaces the TODO(PR6) discard
```

with the invariant stated in the surrounding comment — *"NEVER from item.inputs —
submitters must not be able to claim their own effect tier"*. That is a real
governance property and it works.

**Why the placeholder makes it unreachable.** `capability.imageDigest` is
`sha256:PLACEHOLDER` for both dev shapes, so no dev-shaped item can be dispatched.
`WorkItem.subagentShape` exists in `contracts/types.d.ts` and ships in 0.4.0, and
`packs/` ships compiled in `dist/` — but `OperationsApi.submit` takes no
`PackRegistry`, so a consumer holding this package has no way to supply one.
Verified against the installed 0.4.0: `dist/packs/{dev,data,registry}.js` are all
present and `subagentShape?: string` is on the item type.

So the door and the room both exist; there is no handle on the consumer side.

### What the consumer is doing instead, and what it costs

A verifier is dispatched with the implementer's patch as an input and an
acceptance criterion as prose. **It never receives the base tree.** Every refusal
message in the consumer's snapshot tooling says so, because it is the reason a
stale snapshot is unrecoverable downstream:

> A worker would receive source without the commits in between, and nothing
> downstream would notice — the verifier is shown a patch and a criterion, never
> the base.

Two measured consequences from 20 runs:

**1. The verifier cannot run anything.** The workspace is a `git archive` of
tracked files, so `node_modules/` is absent and no gate can execute. Concretely,
one cycle passed review and all 807 tests, then failed `tsc` on the consumer's
machine:

```
error TS2379: Argument of type '{ authzTier: string | undefined; }' is not
assignable to parameter of type '{ authzTier?: string }' with
'exactOptionalPropertyTypes: true'
```

A full paid cycle for something `pnpm typecheck` answers in ten seconds. With
`contextShape: "repo snapshot + patch applied"` the verifier is in a position to
run it.

**2. Patch-integrity failures are the dominant red.** 3 of 20 runs went red, and
all three were the verifier correctly refusing to certify a patch it could not
read (see #16) — not logic errors. A verifier that could apply the patch would
distinguish "this patch does not apply" from "this change is wrong", which are
different findings with different fixes.

### The ask, smallest first

1. **Pin a real worker image digest** for `devCodeEdit` and `devVerify` — the
   `TODO(PR6)` on line 6 of `packs/dev.ts`.
2. **Expose a pack registry through the submit path**, so a consumer can pass
   `devRegistry()` (or its own) and reference `subagentShape: "dev.verify"` on an
   item. `PackRegistry` is already exported; only the plumbing into
   `OperationsApi` is missing.
3. **Document what `contextShape` guarantees.** "repo snapshot + patch applied" is
   the phrase that makes this valuable, and a consumer needs to know whether it
   means the tree is materialized and writable, whether a toolchain is present,
   and whether the patch is applied before or after capabilities are overlaid.
   `patch-capture.ts` captures its baseline AFTER `overlayCapabilities`, which
   suggests the answer, but it should be stated rather than inferred.

### Why this is worth more than the workaround

The consumer's alternative is shipping `node_modules` as a capability so the agent
can run its own gates. That is ~100 MB and 5,615 files per lockfile change, and it
does not work naively: pnpm's store is symlink-based — 4 of 6 top-level entries in
that tree are symlinks — and the capability format is bytes-at-paths with no
symlink representation, so the bundle either dereferences into something far
larger or lands broken. It would also need `pnpm`, which is absent from
`pangolin-worker:main` (node v20.20.2, npm 10.8.2, git 2.39.5, no pnpm).

Finishing `dev.verify` removes the need for all of that, and it is upstream's own
design rather than a consumer's workaround.

### Not asked for

Typed edges. `outputEdgeType: "patch-ref"` and `inputEdgeTypes` overlap what the
consumer expresses as `needs: { work: { from, select: { kind: "patch" } } }`, and
that duplication is fine — it is working today and is not what this issue is
about.


## Related: CRLF on shell scripts

A fifth issue — all four tracked `.sh` files checking out as CRLF on Windows and
breaking `minio-init` — is fixed separately on `fix/windows-crlf-shell-scripts`.
