# Serve-Stack Known Issues

Found while bringing `deploy/serve-stack` up from a cold start on Windows +
Docker Desktop and running `client/smoke.mjs` end to end.

The run itself was healthy — `submit → dispatch → reconcile → complete` in 15.7s,
with a 4-entry hash-linked chain, matching merkle/anchor roots, a valid signature,
and an `external-immutable` S3 anchor. Every issue below is about the *operator
path*: the runbook, the config defaults, and the verify UX. None indicates a fault
in the orchestration or audit machinery.

Line references are to this branch.

---

## 1. `DOCKER_GID` default of `999` is wrong under Docker Desktop

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

## Related: CRLF on shell scripts

A fifth issue — all four tracked `.sh` files checking out as CRLF on Windows and
breaking `minio-init` — is fixed separately on `fix/windows-crlf-shell-scripts`.
