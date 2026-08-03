# C1′-restore — the mechanism the design commits to (2026-07-31)

Falsification evidence for the chosen mechanism in
[`2026-07-23-worker-env-block-exposure-design.md`](../../2026-07-23-worker-env-block-exposure-design.md).
Third of three experiment sets: [`../2026-07-31-proc-c1/`](../2026-07-31-proc-c1/) refuted C1 and
verified C1′; [`../2026-07-31-proc-gate2-exposed-set/`](../2026-07-31-proc-gate2-exposed-set/) measured
the exposed set.

The mechanism in one line: **the entrypoint `exec`s the worker with a clean environment, hands the
credential over an inherited fd whose file is already unlinked, and the worker restores it into its own
`process.env` — which is not the region `/proc` exposes.**

## `entrypoint.sh` + `worker-sim.mjs` — the hand-off and the restore

```sh
docker run --rm -v "$PWD:/w" -w /w \
  -e AWS_CONTAINER_CREDENTIALS_RELATIVE_URI="/v2/credentials/TOPSECRET-TASK-ROLE" \
  --entrypoint /bin/sh ghcr.io/quarrysystems/pangolin-worker:main /w/entrypoint.sh
```

Expect `=> CLOSED`, exit 0:

```
ENTRYPOINT (pid 1): credential on fd 3, file unlinked, exec'ing — this process ends here
  WORKER (pid 1): read 35 bytes off fd 3
  WORKER: env block before restore clean
  WORKER: process.env after restore HAS SECRET (as intended)
  WORKER: env block after restore  clean
  AGENT : secret found in 0 process env block(s)
  AGENT : positive control visible? yes — instrument works
  AGENT : hand-off file present?    false
```

Three things are being asserted, and each was a premise rather than a certainty:

1. **The fd survives `execve` after the file is unlinked.** This is why the file never exists during the
   agent's lifetime — no window defended by argument. The threat model already concedes mode-`0600`
   "doesn't protect against root or a same-uid process", and the agent is a same-uid process.
2. **The worker is pid 1.** `exec` replaced the shell rather than forking it. A surviving parent holding
   the credential is precisely the defect that refuted C1.
3. **The restore is invisible to `/proc`.** `process.env` mutation reaches glibc's heap-allocated
   `environ`, not the `[env_start, env_end)` stack region the kernel snapshots at `execve` — the same
   asymmetry that made §2's `delete process.env.X` useless, running the other way.

The agent sweep carries a **positive control**. "Found nothing" is the one result that also appears when
the instrument is blind, and `2026-07-31-proc-gate2-exposed-set/probe-false-empty.sh` shows a `/proc`
read returning 0 bytes with the credential plainly present.

## `sdk-restore.mjs` / `sdk-restore-pointer.mjs` — does the SDK see a late restore?

Whether the restore needs *any* package API change turns on this. Run from a directory where
`@aws-sdk/client-s3` resolves:

```sh
D=/opt/pangolin/worker/node_modules/.pnpm/@quarry-systems+pangolin-storage-s3@file+packages+pangolin-storage-s3/node_modules/@quarry-systems/pangolin-storage-s3
docker run --rm -v "$PWD:/w" -w "$D" --entrypoint /usr/bin/env \
  ghcr.io/quarrysystems/pangolin-worker:main -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/pangolin \
  node --input-type=module -e "$(cat /w/sdk-restore.mjs)"
```

| lane | restored after the client was built | result |
|---|---|---|
| static `AWS_ACCESS_KEY_ID` / `SECRET` / `SESSION_TOKEN` | yes | **resolves** — `AKIA-RESTORED-AFTER-START` |
| container pointer | yes | **resolves** — see below |

**The pointer row needs the second script, and this is the part worth reading.** In `sdk-restore.mjs`
the pointer lane *fails* with "Could not load credentials from any providers" — which looks like a
refutation and is not one. A relative URI is hardwired to `169.254.170.2`, which does not exist in a
plain container, so that message is what **both** "never read the variable" and "read it, could not
reach the endpoint" produce. `sdk-restore-pointer.mjs` separates them by pointing
`AWS_CONTAINER_CREDENTIALS_FULL_URI` — the same provider lane, but loopback is permitted — at a local
server and counting requests:

```
pointer set BEFORE client:             AKIA-FROM-ENDPOINT
resolve with NO pointer:               FAILED — CredentialsProviderError
pointer RESTORED after client:         AKIA-FROM-ENDPOINT
endpoint requests total:               2
=> (b): the pointer lane re-reads process.env late.
```

Both lanes therefore tolerate a late restore, and the worker restores *before* constructing anything —
the easier ordering than the one tested here.

## What is still unverified

`AWS_CONTAINER_CREDENTIALS_FULL_URI` was used as a stand-in for `..._RELATIVE_URI`, because the relative
form cannot be pointed at a reachable address. They enter the same provider, so the inference is strong
— but it **is** an inference. The relative-URI form on real Fargate is unverified, and Fargate + S3
parity is already the one maintainer-deferred item. Do not describe it as measured.
