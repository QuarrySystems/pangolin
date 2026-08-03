---
title: Split the Conflated Content Hash in `registerEnv` — Design
date: 2026-08-03
status: **DESIGNED — ready for a plan.** Root cause confirmed by minimal reproduction with a control. One half is explicitly NOT verified and is marked inline.
branch: fix/env-register-split-key-spec
authors: [human:Brett, agent:claude-opus-5]
severity: high (a documented, shipped API path cannot succeed against real storage)
related:
  - ../../../deploy/serve-stack/KNOWN-ISSUES.md # issue 20
  - ../../../packages/pangolin-client/src/env-register.ts # the defect
  - ../../../packages/pangolin-storage-local/src/index.ts # the detector
---

## 1. The defect

`env.register()` carrying `secrets: { KEY: { inline: … } }` throws
`IntegrityMismatchError` against any real `StorageProvider`. Unconditional.

One value is asked to be two incompatible things:

| Role | Needs | Therefore |
|---|---|---|
| **Idempotency key** (`env-register.ts:180`) | stable across stagings | must **exclude** the fresh ref |
| **Content address** (`storage-local:249`) | equals the bytes stored | must **include** the fresh ref |

`:165` hashes `def` with *placeholder* refs; `:205` mutates `def` to the store's
*real* refs; `:228` writes the mutated `def`; `putBlob` re-hashes the bytes and
rejects the mismatch. `computeContentHash` hashes `canonicalize(object)` for an
object and raw bytes for a `Uint8Array` (`content-hash.ts:82-90`), so the two
agree only if `def` is unchanged in between — and it never is.

**Verified by reproduction with a control:** ref == placeholder ⇒ hashes agree;
ref == uuid ⇒ `sha256:0e9f122f…` vs `sha256:5f929124…`.

**Not verified:** that `AwsSecretStore` fails identically. Its ref is a
random-suffixed ARN, so it should — but there are no AWS credentials in this
environment and the claim rests on reading, not running. A plan must measure it
before asserting the fix covers both stores.

## 2. Why the UUID stays

`LocalSecretStore.stage:63` generating `randomUUID()` is not the bug, and removing
it would trade a hashing problem for three worse ones:

1. **Opacity.** The ref is written into the bundle blob, which content-addressed
   storage will hand to anything that can read it. `env-register.ts:190` calls
   these "real opaque refs" deliberately. `pangolin/inline/env-deploy/DEPLOY_TOKEN`
   announces what the secret is for; a UUID announces nothing. The worker `/proc`
   finding established same-uid readers as in scope, so this is not theoretical.
2. **Non-clobbering re-stage.** A fresh id per staging never overwrites a value an
   in-flight dispatch is mid-`resolve()` on. A name-derived id makes `stage()`
   overwrite-in-place.
3. **Per-staging TTL.** Each entry carries its own `stagedAt`; name-keying forces
   TTL reconciliation across re-stagings.

## 3. Design — separate the two roles

**Address the blob by what is actually written. Keep the placeholder-derived hash
as a distinct idempotency key.**

```ts
// EnvDef gains no field. The two hashes become two named values in registerEnv:
const idempotencyKey = computeContentHash(defWithPlaceholders); // stable across stagings
// ... stage inline secrets, mutating secretRefs to real opaque refs ...
const bytes = new TextEncoder().encode(canonicalJsonString(def));
const contentHash = computeContentHash(bytes);                  // addresses these bytes
```

- The **pinned URI** uses `contentHash` — so a `sha256:` URI once again addresses
  its own content, and `putBlob`'s check passes because it is true, not because it
  was disabled.
- The **idempotency check** compares `idempotencyKey`, which must therefore be
  persisted somewhere `resolveLatest` can see. That is the one real design
  question this spec leaves to the plan (§5).
- `EnvRef.contentHash` returned to the caller is the **content** hash, because
  that is what pins the blob a dispatch will fetch.

### 3.1 Where the idempotency key lives

Three candidates, to be settled by a plan against the storage contract:

| Option | Cost |
|---|---|
| A field inside the blob body (`def.idempotencyKey`) | Self-referential: the key is part of the bytes it keys. Requires computing it over the def *excluding* that field — workable but subtle, and subtlety is what produced this defect. |
| The registry index entry beside `contentHash` / `registeredAt` | Cleanest read path (`resolveLatest` already returns that row) but touches the `StorageProvider` contract, so every implementation changes. |
| A sibling blob at a derived URI | No contract change; costs a second round trip per register, and creates a second thing that can be missing. |

**Recommendation: the registry index entry.** The idempotency key is registry
metadata, not bundle content, and the current design's error was precisely putting
registry semantics inside a content hash. This is the option that stops the two
concerns leaking into each other again.

## 4. What must not change

- **`putBlob`'s integrity check stays.** It is the only thing that detected this,
  in the subsystem whose entire pitch is tamper-evidence. A fix that exempts a
  type from it is a fix that deletes the detector.
- **`stage()` semantics stay.** No overwrite-in-place, no name-derived ids (§2).
- **The early-return still skips staging.** `:176-179` is right that staging before
  the check would crash on the second identical call; that ordering is preserved.

## 5. Acceptance criteria

1. `env.register()` with an inline secret succeeds against the **real**
   `LocalStorageProvider` — asserted through `LocalStorageProvider`, never a stub
   that reads the hash out of the URI, since that stub is why this survived.
2. The registered blob, fetched by its pinned URI and re-hashed, equals the URI's
   `sha256:` — the invariant `putBlob` enforces, asserted directly rather than
   inferred from the absence of a throw.
3. The blob body contains the **real opaque ref**, and does not contain the
   placeholder name or the literal secret value. All three asserted in one test:
   two absences with a presence beside them, so the absences are not an empty read.
4. Registering the **same** bundle twice performs exactly one `stage()` call, and
   the second call returns the first `registeredAt`. The single stage call is the
   control proving the early-return fired rather than the test never reaching it.
5. Registering a bundle whose **values** changed performs a second `stage()` and
   yields a different pinned URI.
6. The same five criteria pass against `AwsSecretStore` — **or** the plan records
   why they could not be run and what remains unproven. Silence is not acceptable
   here; §1 already flags this as the unverified half.
7. A regression test lands in a lane that actually executes: not the Docker-gated
   E2E suite, which CI does not run (`e2e.yml:10`). This defect's survival is
   attributable to that lane, and a fix verified only there would be unverified in
   practice.
8. `pnpm -r lint` and `pnpm -r typecheck` clean; existing `env-register` tests pass
   unmodified, or their stub is corrected with the change recorded.

## 6. Open risk

The unit suite's storage stub (`env-register.test.ts:34-37`) reads the content
hash out of the URI instead of computing it. Every test using it is blind to this
entire class of defect. Correcting that stub is arguably a larger win than this
fix — it is the instrument, and the instrument was lying. A plan should decide
whether to fix it here or file it separately, but should not leave it unmentioned.
