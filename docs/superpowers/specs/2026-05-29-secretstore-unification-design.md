---
title: SecretStore unification — every secret through one adapter seam
created: 2026-05-29
status: draft
---

# SecretStore unification

## Problem

The `SecretStore` adapter contract (`agora-core/src/providers.ts`) was designed
to be the single seam through which **every** secret value flows — env-bundle
inline secrets, per-dispatch secrets, and the per-dispatch callback HMAC key —
so the worker has one chokepoint to register each value for log redaction (the
contract's own doc comment states this intent). Two adapters already ship and
are tested: `AwsSecretStore` and `LocalSecretStore`.

But the seam is only ~70% wired:

- **`env-register`** (client) stages inline secrets via the bespoke
  `InlineSecretStager` → AWS Secrets Manager directly. Local env bundles are
  broken.
- **`callback-hmac`** (client) mints + stages via `CreateSecret` directly. Local
  callbacks are broken.
- **worker entrypoint Step 7** (env-bundle secrets) resolves via the bespoke
  `SecretResolver` → AWS `GetSecretValue` directly.
- **`dispatch.ts`** (per-dispatch secrets) already routes through a
  `SecretStore`, but selects it by **sniffing `storage.rootUri` for `file://`**
  rather than an injected choice — and Step 7b in the worker already resolves
  per-dispatch refs through a `SecretStore`. So per-dispatch is migrated;
  env-bundle + callback are not, and the selection is implicit.

`AwsSecretStore`'s own header already declares it "consolidates the logic
previously split across the client's `InlineSecretStager` and
`mintCallbackHmac`, and the resolution logic in the worker's `SecretResolver`."
The destination exists; the call sites were never finished onto it.

## Goal

Full unification: every secret flows through a `SecretStore` adapter chosen
per-dispatch by the target. Delete `InlineSecretStager` and `SecretResolver`.
`agora-client` drops its hard AWS-SDK dependency on the secret path.

## Decisions

1. **Full unification** (not a minimal hook): retire both bespoke seams.
2. **Per-dispatch active store, bundles validated for compatibility.** One
   worker resolves everything in one environment, so a dispatch has exactly one
   active store. An env bundle records the store *kind* it was staged against;
   at dispatch time a mismatch (e.g. a `local-file` bundle sent to an
   `aws-secrets-manager` dispatch) fails loud with a typed error, before firing.
3. **Constructor injection, no AWS default**, scoped **per-target** to match the
   existing `compute` / `credentials` / `targets` pattern:
   - `AgoraClientOptions.secretStores: Record<string, SecretStore>` (defaults to
     `{}` — no implicit AWS).
   - `TargetConfig.secretStore?: string` names the store for that target.
   - `dispatch` resolves `client.secretStores[targetCfg.secretStore]`. Replaces
     the `file://`-URI sniffing.
4. **`storeFromConfig(kind, config)` factory** in `agora-secret-store`, keyed on
   the adapters' own `.name` tokens (`"aws-secrets-manager"`, `"local-file"`).
   Used worker-side to reconstruct the adapter from `AGORA_*` env.
5. **Generalize `SecretRef` from `{ arn: string }` to `{ ref: string }`** in
   `agora-core`. Removes the last backend-shaped name from the public surface
   and honors the contract's "callers treat the ref as opaque, never parse it"
   rule. Cascades to client guards, the CLI `--secret` parsing heuristic (now
   recognizes `local-secret://` as well as `arn:`), and the manifest secret
   shape.
6. **Identity vs config split.** The bundle records the store *kind* (identity);
   the worker supplies *config* (Local's `dir`, AWS's region) from deployment
   env. `dir` is a deployment fact, not a bundle fact.

## Data flow (target state)

**Stage (client):** `registerEnv` / per-dispatch staging / HMAC mint all call
`store.stage({ name, value, ttlSeconds, tags })` on the target's store. The
returned **opaque `ref`** goes into the blob / `AGORA_PER_DISPATCH_SECRET_REFS_JSON`
/ `AGORA_CALLBACK_TOKEN_REF`. `computeInlineSecretTtl` survives as a pure helper
feeding `ttlSeconds`. Cleanup is `store.cleanupByTag('agora:dispatchId', id)`.

**Resolve (worker):** read `AGORA_SECRET_STORE_KIND` (+ `AGORA_SECRET_STORE_DIR`
for Local) → `storeFromConfig(...)` → one `SecretStore`. Resolve env-bundle and
per-dispatch refs through `store.resolve(ref)`, registering each value with the
log redactor as it returns (the chokepoint), then `mergeEnv` (per-dispatch wins).

**Errors:** any `resolve` throw maps to `reason: 'fetch-failed'` in the worker's
loop (replacing the `SecretResolutionError`-keyed mapping). Store mismatch →
typed `SecretStoreMismatchError` at dispatch time. Absent/unknown
`AGORA_SECRET_STORE_KIND` → fail fast at worker boot (config error, not
per-secret).

## Two-PR landing (approach B — refactor first)

- **PR4a (this plan):** the seam. `storeFromConfig`; `SecretRef` rename;
  per-target `secretStores` injection; migrate **per-dispatch + callback + worker
  env-bundle resolution** onto `SecretStore`; delete `SecretResolver`. AWS
  behavior is byte-identical (still ARNs). `env-register` keeps
  `InlineSecretStager` untouched in this PR (only its `SecretRef` field-rename
  ripple). Local per-dispatch secrets begin working via an injected
  `LocalSecretStore`.
- **PR4b (follow-up plan):** migrate `env-register` onto the per-target store
  (new `target`/store parameter, since `register()` has no target), record
  store-kind on the bundle blob, add the dispatch-time compatibility check,
  delete `InlineSecretStager`, and battle-test local env bundles end-to-end on
  real Docker with zero AWS — closing the original gap.

## Why split env-register to PR4b

Env bundles are staged at `register()` time, which carries **no target**, so
migrating `env-register` onto a per-target store requires a new
target/store-selection parameter. That is inseparable from the store-kind-on-blob
and compatibility-check work. Keeping it in PR4b lets PR4a be a clean,
behavior-preserving refactor whose verification is "the existing AWS e2e suite
stays green," and puts the actual battle-test gap (local env bundles) in the PR
that fixes it.

## Testing

- **PR4a verification:** AWS e2e assertions unchanged
  (`inline-secret-lifecycle`, `runtime-secret-redaction`,
  `callback-signing-roundtrip`, `fargate-cloud-path`, `credentials-rejection`);
  construction sites updated to pass `secretStores` only where secrets are
  staged. `agora-worker/test/secret-resolver.test.ts` deleted with its subject.
- **New unit coverage:** `storeFromConfig` (kind→adapter, unknown kind throws);
  worker resolve-loop `fetch-failed` mapping; `mintCallbackHmac` via injected
  store; `{ref}` type guards.
