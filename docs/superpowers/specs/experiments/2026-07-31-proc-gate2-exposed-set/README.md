# /proc exposure — gate item 2: the exposed set, measured (2026-07-31)

Runnable evidence for §5 item 2 of
[`2026-07-23-worker-env-block-exposure-design.md`](../../2026-07-23-worker-env-block-exposure-design.md).
Sibling of [`../2026-07-31-proc-c1/`](../2026-07-31-proc-c1/), which refuted C1 and verified C1′.

Constraint 4 says the exposed set "must be enumerated, not guessed." These run in the **real worker
image** rather than reading the code, because the image and the Docker daemon contribute vars that no
amount of grepping `dispatch.ts` will surface — `HOSTNAME`, `HOME`, `NODE_VERSION`, `YARN_VERSION`.

## `enumerate-exposed-set.sh` — what an agent recovers, local-docker path

```sh
sh docs/superpowers/specs/experiments/2026-07-31-proc-gate2-exposed-set/enumerate-exposed-set.sh
```

Expect **27 names** out of a 996-byte env block, read by a child started with `env -i` — the agent's
real position, same uid, own environment already empty. Among them: the full static AWS chain, the
callback HMAC key ref, the callback bearer ref, and the per-dispatch secret-ref map.

The conclusion this run supports is in the spec's §3a: the recovered set is **not** confined to
`AWS_*`/`PANGOLIN_*`, and on Fargate it is not enumerable by Pangolin at all.

## `probe-false-empty.sh` — the instrument can lie

```sh
sh docs/superpowers/specs/experiments/2026-07-31-proc-gate2-exposed-set/probe-false-empty.sh
```

`$(wc -c < /proc/self/environ)` reports **0 bytes** while `/proc/1/environ` in the same container
plainly holds the credential. Rows 1 and 5 are the same command; only the command substitution differs.

This is the third false-PASS trap this finding has produced, and the first one in the *measurement*
rather than the setup. It matters specifically because §5 asks for a tripwire asserting a probe finds
nothing — written naively, that assertion passes on an instrument that can see nothing at all. **Give
any such test a positive control**: a credential known to be present, which the probe must recover, in
the same run that asserts the protected one is absent.

Only the behaviour is established. The kernel path producing it is not, and nothing here should be
written up as though it were.
