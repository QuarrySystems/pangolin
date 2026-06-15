# Secret-handling hardening — design

**Date:** 2026-06-14
**Status:** approved (brainstorm complete)
**Author:** agent:brett
**Scope:** `pangolin-worker`, `pangolin-runtime-claude-code`, `pangolin-providers-local-docker`, `pangolin-secret-store`, `pangolin-client`

## Problem

A focused read-only security audit of the secret-handling seam (the surface sensitive
credentials actually flow through, last re-audited before the seal work) surfaced a
single root cause with several symptoms, plus a cluster of smaller bypasses.

**Root cause — redaction is opt-in by classification.** Only values resolved through a
`SecretStore` (`secretRefs` / per-dispatch refs) are `registerSecret()`'d for
redaction (`pangolin-worker/src/entrypoint.ts:362,386`). Anything that arrives as a
plain env-bundle `value`, or as output from a channel that never enters the
`StructuredLogger`, is never in the redaction set. So the credential scanner (a coarse
sieve) and the env firewall (default-allow) become the *sole* gates, and a single miss
is a guaranteed plaintext leak into worker stdout, the structured log, and the retained
operational `record.json`.

The cryptographically **sealed** `AuditBundle`/export remains refs-only and clean — no
secret value reaches it. The leaks below are threat (c)/(d) ("logged"/"persisted"),
landing in the worker log stream and the operational dispatch record, not in the sealed
evidence. Still real; scoped accurately.

This spec hardens seven findings. The key-custody gap (#5) is handled separately as a
vault `decision` page, not in this spec.

## Findings in scope

| # | Sev | Location | Fix |
|---|-----|----------|-----|
| F1 | high | `pangolin-worker/src/entrypoint.ts` + `env-merger.ts` | register env-bundle `values` for redaction |
| F2 | high | `pangolin-worker/src/runtime-env-filter.ts` | default-deny allow-list + operator passthrough |
| F3 | high | `pangolin-runtime-claude-code/src/plugin-installer.ts` | capture+redact instead of `stdio:"inherit"` |
| F6 | med | `pangolin-worker/src/channel-loader.ts` | route `console.error` through the redactor |
| F9 | low | `pangolin-providers-local-docker/src/index.ts` | bind secret dir `:ro` |
| F10 | low | `pangolin-secret-store/src/local-secret-store.ts` | path-safety guard in `cleanupByTag` |
| F12 | low | `pangolin-client/src/credential-pattern.ts` | reduce matched-value disclosure in error |

The remaining audit findings (F4 scanner coverage, F5 `work.input` scanning, F7 encoded-secret
redaction variants, F8 binary-input scanning, F11 adapter `console.warn`, F13 record.json raw
retention) are deliberately **out of scope** for this campaign; F1 reduces the blast radius of
F4/F5/F8 (a misclassified secret is still redacted), and they are recorded for a later pass.

## The seven units

Each unit is independently implementable and testable. Order does not matter except that F1
and F2 both touch `pangolin-worker` env assembly and share test files.

### F1 — Redact all runtime-bound env values (worker)

**What it does:** ensures every value that crosses into the agent's runtime env is in the
redaction set, so redaction no longer depends on the scanner having classified the value as a
secret.

**Change:** in `entrypoint.ts` step 7, when building each `EnvBundle`, after collecting
`def.values`, call `logger.registerSecret(v)` for every value `v` in `def.values` (the existing
`length > 0` guard in `registerSecret` already skips empty strings). `secretRefs`-resolved
values and per-dispatch secrets continue to be registered as before. No change to `mergeEnv` or
to what is *sent* — only to the redaction set.

**Why not register at `mergeEnv`:** `mergeEnv` also folds in `baseEnv` (PATH, HOME, locale),
which we must NOT register (registering `PATH` would corrupt every log line). Registration must
be scoped to dispatch-supplied bundle values only, which is the `entrypoint.ts` step-7 site.

**Interface:** none changed. Behavior change is "more values redacted."

**Tests:** an env-bundle `values` entry whose value appears in a subsequently-logged string is
redacted; a `baseEnv` value (e.g. a fake `PATH`) is NOT registered (no over-redaction of common
substrings); empty `values` entry does not register.

### F2 — Env firewall: default-deny allow-list + operator passthrough (worker)

**What it does:** inverts `filterRuntimeEnv` from a deny-list (pass everything except
`PANGOLIN_*` + 8 AWS names) to a default-DENY allow-list, so leaking a credential into the
prompt-injectable agent requires an explicit operator action rather than being the ambient
default.

**Rule:**
```
filterRuntimeEnv(env, { allow? }) → keep key IFF
    key ∈ BUILTIN_ALLOW
 OR key matches an entry of `allow` (exact name, or `PREFIX_*` trailing-glob)
otherwise DROP
```

`BUILTIN_ALLOW` (exact names): `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LANGUAGE`,
`TZ`, `TERM`, `TMPDIR`, `TMP`, `TEMP`, `NODE_ENV`, `AWS_REGION`, `AWS_DEFAULT_REGION`.
`BUILTIN_ALLOW` (prefix): `LC_` (covers `LC_ALL`, `LC_CTYPE`, …).

`NODE_ENV` is load-bearing and non-credential: the worker image sets it
(`docker/pangolin-worker/Dockerfile:104`) and the Node-based `claude` CLI and node-based verify
scripts (e.g. `pnpm test`) branch on it. Under default-deny it would otherwise be stripped from
the child env — the single most likely "starve" regression, so it is a built-in, not an
operator opt-in.

**git is unaffected:** `patch-capture.ts` spawns `git` with **no** `env` option, so git inherits
the worker's full unfiltered `process.env` (HOME/PATH), not the filtered child env. No `GIT_*`
entries are needed in `BUILTIN_ALLOW`.

**Config plumbing:** new optional `PANGOLIN_RUNTIME_ENV_ALLOW` (comma-separated names/prefixes)
parsed in `parseWorkerEnv` → `WorkerConfig.runtimeEnvAllow: string[]`. `entrypoint.ts` passes
`filterRuntimeEnv(rawBase, { allow: cfg.runtimeEnvAllow })`. The var itself starts with
`PANGOLIN_`, so it is configuration read by the worker and is never a candidate for passthrough.

**Glob semantics:** an `allow` entry ending in `*` is a prefix match on the remainder
(`MYAPP_*` matches `MYAPP_FOO`); otherwise exact. No other glob metachar is interpreted (the
`*` is stripped and treated as `startsWith`). Empty/whitespace entries are ignored.

**Old machinery removed:** `AWS_CREDENTIAL_VARS` and the `PANGOLIN_` prefix-strip are no longer
needed — default-deny excludes both. The `opts.deny` field is removed (no caller used it for
anything the allow-list does not now cover; confirm via grep during implementation and, if any
caller passes `deny`, convert it).

**Migration / blast radius (documented in module header + spec):** agent-needed credentials
already flow the secret lane — the canonical examples stage `ANTHROPIC_API_KEY` as an inline
per-dispatch/env-bundle secret (`examples/dogfood-gated/src/index.ts:221`,
`examples/demo-claims-appeals/src/index.ts:168`,
`examples/demo-claims-appeals-minio/README.md:303`), which is resolved through the SecretStore,
registered for redaction, and merged ON TOP of `baseEnv`. So inverting the firewall strips the
key from `baseEnv` but the merge re-adds it; **agent auth does not break** on the canonical
path. The only behavior change is for a deploy that relied on *inheriting* an arbitrary
non-credential user var into the agent: it must now add that var to `PANGOLIN_RUNTIME_ENV_ALLOW`
or supply it via an env bundle. **Deploys behind a TLS-intercepting proxy or with a custom CA
must add `NODE_EXTRA_CA_CERTS` and/or `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` to
`PANGOLIN_RUNTIME_ENV_ALLOW`** — these are deliberately not built-in (they are deploy-specific),
but omitting them silently breaks agent egress, so the migration note names them explicitly.

**Tests:** built-in vars pass; an arbitrary var (`GITHUB_TOKEN`, `FOO`) is dropped; an
`allow` exact name passes; an `allow` `PREFIX_*` glob passes matching keys and drops
non-matching; `LC_*` builtin prefix passes; `NODE_ENV` passes; `PANGOLIN_*` and the AWS
credential trio are dropped (now by absence from the allow-list, not by an explicit deny); input
object not mutated. `parseWorkerEnv` parses `PANGOLIN_RUNTIME_ENV_ALLOW` to a trimmed string
array (absent → `[]`).

**Stale tests to UPDATE (not loosen) — named per the policy-tightening blast-radius lesson:**
- `pangolin-worker/test/runtime-env-filter.test.ts:65-71` ("strips additional keys passed via
  `opts.deny`") — delete this case together with the `opts.deny` field (the only `deny` user in
  the repo; no production caller passes it).
- `pangolin-worker/test/entrypoint.test.ts:433` asserts `captured!.LOG_LEVEL === 'debug'` — under
  default-deny `LOG_LEVEL` is dropped. Update the test to reflect the new rule (either assert
  `LOG_LEVEL` is now absent, or stage it through `PANGOLIN_RUNTIME_ENV_ALLOW` if the test means to
  exercise passthrough). Do NOT re-add `LOG_LEVEL` to `BUILTIN_ALLOW` to make the old assertion
  pass — that would defeat the tightening. (The `AWS_REGION` assertion at :432 still passes —
  it is a built-in.)

### F3 — Plugin-install capture + redact (runtime-claude-code)

**What it does:** the one channel that pipes the full secret-bearing merged env's child output
straight to the container stream is `claude plugins install` with `stdio:"inherit"`. Capture its
output in memory and route it through the worker's redactor instead.

**Constraint discovered in spec audit:** `RuntimeContext` (`pangolin-core/src/runtime-adapter.ts`)
is `{ dispatchId, env, telemetry? }` — there is **no** `ctx.log`/`ctx.redact`, and the adapter is
invoked with only `{ dispatchId, env }` (`pipeline-runner.ts:128-131`). So there is nothing for a
"redacting log callback" to wire to without a pangolin-core interface change. We therefore scope
F3 as **buffer-and-throw**, which closes the leak with no interface change.

**Change:** in `plugin-installer.ts`, replace `stdio:"inherit"` with piped stdout/stderr
captured to in-memory strings (mirroring `claude-spawn.ts`). Output is **never** written raw to
the worker's fd1/fd2.
- On **non-zero exit / spawn error**: throw fail-fast with the plugin name AND the captured
  stdout/stderr appended to the error message. This error propagates to the worker's `failWith`,
  whose long-form `detail` is emitted only through `logger.log` (redacted) and is never sealed
  raw (verified: `entrypoint.ts` failWith sends only the canonical reason token to webhooks). So
  the install diagnostics survive for debugging, redacted, without a raw channel.
- On **success**: the captured output is discarded in production (a small, acceptable
  observability tradeoff for the security win). An optional `onOutput?: (chunk: { stream:
  'stdout'|'stderr'; text: string }) => void` is added to `InstallPluginsOptions` purely so tests
  can assert capture occurred; production callers (the adapter) pass nothing.

**Interface:** `InstallPluginsOptions` gains optional `onOutput`. No `RuntimeContext` change. If
live redacted emission of success output is later wanted, that is a separate change adding an
optional redacting hook to `RuntimeContext` and threading it from `pipeline-runner.ts` — out of
scope here.

**Tests:** install child output containing a secret is captured, not written raw to fd1/fd2
(assert via `onOutput` capture + no inherited stdio); a failing install throws with the plugin
name and the captured output present in the error message; absent `onOutput` does not inherit
stdio (no raw write).

### F6 — Channel-loader diagnostics through the redactor (worker)

**What it does:** the three `console.error(String(err))` calls in `channel-loader.ts` bypass the
redactor; a channel-adapter auth error with credentials in a broker URL would print in clear.

**Change:** thread the `StructuredLogger` (or a `(event) => void` redacting log fn) into
`loadChannelIfPresent` and replace each `console.error` with
`logger.log({ kind: 'channel.error', detail: String(err), inboxPath })` (or equivalent
structured event). No behavioral change beyond redaction + structured form.

**Tests:** a channel-load error whose message contains a registered secret is redacted in the
emitted event; the loader still surfaces the error condition (return value / control flow
unchanged).

### F9 — `:ro` secret mount (local-docker)

**Change:** `index.ts` secret bind becomes
`` `${secretDir}:${this.secretStoreMountTarget}:ro` ``. The storage mount (result writes) stays
RW. The worker only ever reads secret files, so read-only is correct.

**Tests:** the generated bind string for the secret dir ends with `:ro`; the storage bind does
not.

### F10 — `cleanupByTag` path-safety guard (secret-store)

**Change:** in `local-secret-store.ts` `cleanupByTag`, after deriving `id` from the readdir
entry, `if (isUnsafeSegment(id)) continue;` before constructing `valuePath`/`metaPath`. Invariant
uniformity — every join of an id goes through the same guard. Unreachable today (readdir yields
basenames) but removes a future-change footgun.

**Tests:** `cleanupByTag` skips an entry whose derived id is unsafe (inject via a fake readdir
in the existing test seam if present; otherwise assert the guard is called / the safe path still
cleans normally). Existing cleanup behavior unchanged for legitimate ids.

### F12 — Scanner error partial-disclosure (client)

**Change:** in `credential-pattern.ts:67`, the `CredentialsInEnvError` detail currently includes
`match[0].slice(0, 16)`. Reduce to a fixed 8-char prefix (so a ~20-char secret no longer leaks
16 of its chars), keeping the field name. **Also update the stale comment at
`credential-pattern.ts:30`** ("first 16 chars folded into the error") to 8, so comment and code
agree. The existing regression test asserting the full key is absent stays; add a short-secret
(~20 char) case asserting ≤ 8 chars of the value appear.

**Tests:** error detail for a 20-char secret contains at most 8 chars of the matched value; the
full value is never present (existing test retained).

## Out of scope

- Key custody (#5) — separate vault `decision` page.
- F4/F5/F7/F8/F11/F13 — recorded for a later pass; F1 reduces their severity.
- KMS/HSM build — not in this campaign.

## Testing strategy

TDD per unit. Each unit ships a failing test first, then the fix. Because F1 and F2 tighten
shared worker env assembly, the full `pnpm -r test` is the net for stale assertions (per the
policy-tightening blast-radius lesson): `pnpm -r typecheck` only proves callers are
type-correct, not that runtime assertions still hold. Existing tests in
`pangolin-worker/test/runtime-env-filter.test.ts`, `index.test.ts`, and `entrypoint.test.ts`
that assert the old default-allow behavior or unredacted `values` will be updated to satisfy the
new rule (sign/stage/allow legitimately), never loosened to accept the weaker state. Full gate:
`pnpm -r typecheck` + `pnpm -r test` + per-package `lint`. In a fresh worktree, `pnpm -r build`
before trusting cross-package failures (stale-dist gotcha).
