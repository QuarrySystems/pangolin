# /proc exposure — C1 refutation and C1′ verification (2026-07-31)

Runnable evidence for §4 of
[`2026-07-23-worker-env-block-exposure-design.md`](../../2026-07-23-worker-env-block-exposure-design.md).

These are kept because that spec's §2 records a design that was reasoned carefully and was wrong about
the one fact a thirty-second container run would have settled. Re-run these rather than trusting the
transcript.

Both run as **uid 1000** — the real worker starts as `USER pangolin` and never `setuid`s. That matters:
see the spec's "Testing note — a trap that produces a false PASS". A test that drops privileges *after*
start clears the kernel's `dumpable` flag, reassigns `/proc/<pid>/*` to root, and concludes the exposure
does not exist.

## C1 as described — REFUTED

The launcher stays alive to own the inherited fd, so its own env block still holds the credential.

```sh
docker run --rm -v "$PWD:/w" -w /w -u 1000 \
  -e AWS_CONTAINER_CREDENTIALS_RELATIVE_URI="/v2/credentials/TOPSECRET-TASK-ROLE" \
  node:22-bookworm-slim node c1-launcher-leak.mjs
```

Expect: worker clean, agent clean, **secret found in pid 1** — `=> STILL OPEN`.

## C1′ — VERIFIED CLOSED

A POSIX shell `exec`s the worker (replacing its own image, so nothing survives holding the credential)
and hands the value over a private file the worker `unlink`s at startup.

```sh
docker run --rm -v "$PWD:/w" -w /w -u 1000 \
  -e AWS_CONTAINER_CREDENTIALS_RELATIVE_URI="/v2/credentials/TOPSECRET-TASK-ROLE" \
  --entrypoint sh node:22-bookworm-slim /w/c1-exec-variant.sh
```

Expect: worker is **pid 1** (proving `exec` replaced rather than forked), **0 process env blocks** carry
the secret, hand-off file absent — `=> CLOSED`.

## What these do NOT cover

The credentials seam (spec §4, "C1 half 2"). That was measured separately against MinIO: injected static
and refreshing credentials both sign correctly and the provider **is** re-invoked on expiry, while
`S3StorageProvider({ credentials })` silently ignores the field. Reproduce with any S3-compatible
endpoint; the finding is that `S3StorageProviderOpts` has no `credentials` member.
