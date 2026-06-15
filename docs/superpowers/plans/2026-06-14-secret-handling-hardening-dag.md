# Secret-handling hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close seven secret-handling findings so redaction no longer depends on classification, the env firewall fails closed, and no channel bypasses redaction.

**Architecture:** Seven independent units across five packages. The two structural fixes are F1 (register all dispatch-supplied env-bundle `values` for redaction) and F2 (invert the worker env firewall to a default-deny allow-list with an operator passthrough). The rest close localized bypasses. Each task is TDD: failing test → minimal fix → green → commit.

**Tech Stack:** TypeScript, pnpm workspace, vitest. Spec: `docs/superpowers/specs/2026-06-14-secret-handling-hardening-design.md`.

**Worktree note:** in a fresh worktree run `pnpm install && pnpm -r build` once before trusting any cross-package typecheck/test failure (stale-dist gotcha). Tasks are independent and may be done in any order; do them in listed order to keep commits clean.

---

### Task 1: F10 — path-safety guard in `cleanupByTag`

**Files:**
- Modify: `packages/pangolin-secret-store/src/local-secret-store.ts` (export `isUnsafeSegment`; add guard in `cleanupByTag`)
- Test: `packages/pangolin-secret-store/test/local-secret-store.test.ts`

**Approach note (from plan audit):** the guard is genuinely unreachable through a real `readdir`
(basenames cannot contain `/` or `..`), and `vi.spyOn` on a `node:fs/promises` named import does
NOT reliably intercept the SUT's binding under native ESM. So we do not fake `readdir`. Instead we
(a) **export `isUnsafeSegment`** and unit-test the security primitive both guards rely on directly,
and (b) keep a normal-path `cleanupByTag` regression test. The guard wiring itself is a
self-evident one-liner; this is proportionate coverage for a low-severity defense-in-depth /
invariant-uniformity fix.

- [ ] **Step 1: Write the failing test**

Add to `local-secret-store.test.ts`:

```typescript
import { LocalSecretStore, isUnsafeSegment } from "../src/local-secret-store.js";
// (mkdtemp/tmpdir/join already imported by the existing suite; add isUnsafeSegment to the import)

describe("isUnsafeSegment (path-safety primitive, F10)", () => {
  it("rejects traversal / separator / empty / NUL ids and accepts safe ids", () => {
    for (const bad of ["", ".", "..", "a/..", "../escape", "a/b", "a\\b", "a\0b"]) {
      expect(isUnsafeSegment(bad)).toBe(true);
    }
    for (const ok of ["abc", "local-secret-id", "550e8400-e29b-41d4-a716-446655440000"]) {
      expect(isUnsafeSegment(ok)).toBe(false);
    }
  });
});

describe("LocalSecretStore.cleanupByTag (F10 regression: normal path still cleans)", () => {
  it("removes a tagged secret and leaves an untagged one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lss-f10-"));
    const store = new LocalSecretStore({ dir });
    const tagged = await store.stage({ name: "A", value: "va", ttlSeconds: 60, tags: { "pangolin:dispatchId": "d-1" } });
    const other = await store.stage({ name: "B", value: "vb", ttlSeconds: 60, tags: { "pangolin:dispatchId": "d-2" } });
    await store.cleanupByTag("pangolin:dispatchId", "d-1");
    await expect(store.resolve(tagged.ref)).rejects.toThrow();   // removed
    await expect(store.resolve(other.ref)).resolves.toBe("vb");  // untouched
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-secret-store test -- local-secret-store`
Expected: FAIL — `isUnsafeSegment` is not exported (import error).

- [ ] **Step 3: Export the primitive + add the guard**

In `local-secret-store.ts`, change the `function isUnsafeSegment` declaration (line 29) to
`export function isUnsafeSegment`. Then in `cleanupByTag`, after
`const id = entry.slice(0, -".meta.json".length);` (line 97), add:

```typescript
      if (isUnsafeSegment(id)) continue;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @quarry-systems/pangolin-secret-store test -- local-secret-store`
Expected: PASS. Confirm pre-existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/pangolin-secret-store/src/local-secret-store.ts packages/pangolin-secret-store/test/local-secret-store.test.ts
git commit -m "fix(secret-store): path-safety guard on cleanupByTag readdir id (F10)"
```

---

### Task 2: F12 — reduce matched-value disclosure in scanner error

**Files:**
- Modify: `packages/pangolin-client/src/credential-pattern.ts:29-30` (comment) and `:51-52` (docstring) and `:66` (slice)
- Test: `packages/pangolin-client/test/credential-pattern.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the existing describe block:

```typescript
it("discloses at most 8 chars of the matched value in the error detail (F12)", () => {
  // A 20-char OpenAI-shaped key: prefix sk- + 20 alnum.
  const secret = "sk-ABCDEFGHIJKLMNOPQRST";
  try {
    assertNoCredentialPattern("env-bundle:test:OPENAI", secret);
    throw new Error("expected assertNoCredentialPattern to throw");
  } catch (err) {
    const detail = (err as Error).message;
    // Full secret never present.
    expect(detail).not.toContain(secret);
    // At most 8 chars of the matched substring are shown.
    expect(detail).toContain(secret.slice(0, 8));
    expect(detail).not.toContain(secret.slice(0, 9));
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-client test -- credential-pattern`
Expected: FAIL — current code uses `slice(0, 16)`, so `secret.slice(0, 9)` IS present.

- [ ] **Step 3: Reduce the slice + fix the stale comment**

`credential-pattern.ts:66` — change `match[0].slice(0, 16)` to `match[0].slice(0, 8)`:

```typescript
        `${name} pattern matched: ${match[0].slice(0, 8)}...`,
```

`credential-pattern.ts:29-30` — change the comment "The first 16 chars folded into the error" to "The first 8 chars folded into the error".

`credential-pattern.ts:51-52` — change the docstring "the first 16 chars of the matched substring" to "the first 8 chars of the matched substring".

- [ ] **Step 3b: Update the existing disclosure test (it asserts the old 16)**

`credential-pattern.test.ts:275-287` (the "includes only the first 16 chars" test) asserts
`detail.toContain(fullKey.slice(0,16))` — it will fail after the change. Update it: retitle to
"…first 8 chars", change the `slice(0, 16)` assertion to `slice(0, 8)`, and assert
`not.toContain(slice(0, 9))`. Keep the "full key absent" assertion in that test.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @quarry-systems/pangolin-client test -- credential-pattern`
Expected: PASS, including the pre-existing "full key absent" test.

- [ ] **Step 5: Commit**

```bash
git add packages/pangolin-client/src/credential-pattern.ts packages/pangolin-client/test/credential-pattern.test.ts
git commit -m "fix(client): cap scanner error disclosure at 8 chars (F12)"
```

---

### Task 3: F9 — bind the per-dispatch secret dir read-only

**Files:**
- Modify: `packages/pangolin-providers-local-docker/src/index.ts:187`
- Test: `packages/pangolin-providers-local-docker/test/smoke.test.ts` (the real bind harness — `prepareEnvAndBinds` is private; binds are asserted via the `createContainer` spy → `HostConfig.Binds`, see the "secret store bind-mount" describe ~lines 138-197)

- [ ] **Step 1: Write the failing test**

Add to `smoke.test.ts` in the secret-store bind-mount describe, mirroring its existing
`provider.run(...)` + `createContainer`-spy pattern. The existing assertions use
`.toContain('...:/pangolin/secrets')` (substring) and survive the `:ro` suffix; this new test
asserts the suffix explicitly:

```typescript
it("binds the per-dispatch secret dir read-only (F9)", async () => {
  // Mirror the existing secret-bind test's setup: a docker double whose
  // createContainer is a spy, and a spec with PANGOLIN_SECRET_STORE_DIR set.
  const createSpy = vi.fn(async () => ({ id: "ro1", start: async () => {} }));
  const provider = new LocalDockerProvider({ docker: { createContainer: createSpy } as never });
  await provider.run(baseSpec({ env: { PANGOLIN_SECRET_STORE_DIR: "/host/secrets" } }), baseCtx);

  const arg = createSpy.mock.calls[0]![0] as { HostConfig?: { Binds?: string[] } };
  const binds = arg.HostConfig?.Binds ?? [];
  const secretBind = binds.find((b) => b.includes("/pangolin/secrets"));
  expect(secretBind?.endsWith(":ro")).toBe(true);
});
```

Use the file's existing `baseSpec`/`baseCtx` helpers and the same `LocalDockerProvider`
construction as the neighbouring secret-bind test (read lines ~138-197 first and match them —
the exact docker-double shape and mount target string come from there).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-providers-local-docker test -- smoke`
Expected: FAIL — secret bind currently has no `:ro` suffix.

- [ ] **Step 3: Add `:ro` to the secret bind**

`index.ts:187` — change:

```typescript
      binds.push(`${secretDir}:${this.secretStoreMountTarget}:ro`);
```

(The storage bind at line 175 stays unchanged — result writes need RW.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @quarry-systems/pangolin-providers-local-docker test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pangolin-providers-local-docker/src/index.ts packages/pangolin-providers-local-docker/test/
git commit -m "fix(local-docker): mount per-dispatch secret dir read-only (F9)"
```

---

### Task 4: F1 — register env-bundle `values` for redaction

**Files:**
- Modify: `packages/pangolin-worker/src/entrypoint.ts:344-366` (step 7 env-bundle loop)
- Test: `packages/pangolin-worker/test/index.test.ts` (env-bundle harness at lines 415-507 is the pattern)

- [ ] **Step 1: Write the failing test**

Add a new `it` near the existing env-bundle test in `index.test.ts`. It mirrors that harness but puts a secret-shaped string in `values` (NOT `secretRefs`), has the adapter echo it in stderr with a non-zero exit (so the failure path logs stderr), spies on `process.stdout.write`, and asserts the value is redacted. Concrete:

```typescript
it("registers env-bundle plain `values` for log redaction (F1)", async () => {
  // --- reuse the same adapter-on-disk + subagent setup as the sibling test ---
  // (copy the subagent/cap bundle + adaptersRoot + workDir setup from the
  //  "resolves env-bundle secrets" test above; only the envDef + adapter +
  //  assertions below differ.)
  const LEAKY_VALUE = "plainval-SHOULD-BE-REDACTED-1234567890";
  const envDef = { values: { LEAKY: LEAKY_VALUE }, secretRefs: {} };
  const envBytes = asJsonBytes(envDef);
  const envUri = "pangolin://ns/env/env-f1/sha256:e";
  const envHash = computeContentHash(envDef);

  const storage = new FakeStorage();
  storage.set(subagentUri, asJsonBytes(subagentDef));
  storage.set(capUri, capBytes);
  storage.set(envUri, envBytes);

  const bundleRefs = {
    subagent: { uri: subagentUri, contentHash: subagentHash },
    capabilities: [{ uri: capUri, contentHash: capHash }],
    env: [{ uri: envUri, contentHash: envHash }],
  };
  const env: Record<string, string> = {
    PANGOLIN_DISPATCH_ID: "d-f1-1",
    PANGOLIN_NAMESPACE: "ns",
    PANGOLIN_STORAGE_URI: "file:///fake",
    PANGOLIN_BUNDLE_REFS_JSON: JSON.stringify(bundleRefs),
    PANGOLIN_RUNTIME_ADAPTER: "claude-code",
  };

  const adapter: RuntimeAdapter = {
    name: "claude-code",
    reservedPaths: [],
    // Non-zero exit, stderr echoes the plain value → logged via StructuredLogger.
    invoke: async () => ({ exitCode: 7, stdout: "", stderr: `boom ${LEAKY_VALUE}` }),
  };

  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    },
  );
  const deps: RunWorkerDeps = {
    storage, adapter, adaptersRoot, workspaceDir: workDir,
    secretStore: { name: "fake", resolve: async () => "x", stage: async () => ({ ref: "x", ttlSeconds: 1 }), cleanupByTag: async () => {} },
    fetchImpl: async () => new Response(null, { status: 204 }),
  };
  try {
    await runWorker(env, deps);
  } finally {
    spy.mockRestore();
  }
  const allLogs = writes.join("");
  expect(allLogs).not.toContain(LEAKY_VALUE);
  expect(allLogs).toContain("<redacted:secret>");
});
```

Note: copy the `subagentDef/subagentUri/subagentHash/capFiles/capBytes/capUri/capHash/adaptersRoot/workDir` setup verbatim from the existing "resolves env-bundle secrets" test (lines ~395-445) — they are local consts in that test's scope, so the new test needs its own copies.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-worker test -- index`
Expected: FAIL — `allLogs` contains `LEAKY_VALUE` raw (plain `values` are not registered today).

- [ ] **Step 3: Register `values` in the env-bundle loop**

`entrypoint.ts` step 7 — inside `for (const envBundle of bundles.envs)`, after the `secretRefs` loop and before `envBundles.push(...)`, register each plain value too:

```typescript
    // F1: register env-bundle plain `values` for redaction too. Redaction must
    // not depend on the client-side scanner having classified a value as a
    // secret — a misclassified credential in `values` is still scrubbed from
    // the worker's logs. (registerSecret skips empty strings.)
    for (const v of Object.values(def.values ?? {})) {
      logger.registerSecret(v);
    }
    envBundles.push({ values: def.values ?? {}, secrets: resolvedSecrets });
```

(Replace the existing `envBundles.push(...)` line with the block above.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @quarry-systems/pangolin-worker test -- index`
Expected: PASS. Confirm the pre-existing env-bundle test (asserting `STATIC_VAR`/`API_KEY` injection) still passes — F1 is additive.

- [ ] **Step 5: Commit**

```bash
git add packages/pangolin-worker/src/entrypoint.ts packages/pangolin-worker/test/index.test.ts
git commit -m "fix(worker): redact env-bundle plain values, not only secretRefs (F1)"
```

---

### Task 5: F2 — env firewall default-deny allow-list + operator passthrough

**Files:**
- Modify: `packages/pangolin-worker/src/runtime-env-filter.ts` (full rewrite of the filter)
- Modify: `packages/pangolin-worker/src/env-parser.ts` (parse `PANGOLIN_RUNTIME_ENV_ALLOW`)
- Modify: `packages/pangolin-worker/src/entrypoint.ts:401` (pass `allow`)
- Test: `packages/pangolin-worker/test/runtime-env-filter.test.ts` (rewrite), `packages/pangolin-worker/test/env-parser.test.ts` (add), `packages/pangolin-worker/test/entrypoint.test.ts:432-433` (update)

- [ ] **Step 1: Rewrite the filter test for default-deny**

Replace the whole body of `runtime-env-filter.test.ts` with:

```typescript
import { describe, it, expect } from "vitest";
import { filterRuntimeEnv } from "../src/runtime-env-filter.js";

describe("filterRuntimeEnv (default-deny allow-list)", () => {
  it("passes built-in non-credential vars", () => {
    const out = filterRuntimeEnv({
      PATH: "/usr/bin", HOME: "/home/pangolin", LANG: "C.UTF-8",
      TZ: "UTC", TERM: "xterm", NODE_ENV: "production",
      AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "us-east-1",
    });
    expect(out).toEqual({
      PATH: "/usr/bin", HOME: "/home/pangolin", LANG: "C.UTF-8",
      TZ: "UTC", TERM: "xterm", NODE_ENV: "production",
      AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "us-east-1",
    });
  });

  it("passes LC_* by built-in prefix", () => {
    const out = filterRuntimeEnv({ LC_ALL: "C", LC_CTYPE: "UTF-8" });
    expect(out).toEqual({ LC_ALL: "C", LC_CTYPE: "UTF-8" });
  });

  it("DROPS arbitrary user vars and credentials by default", () => {
    const out = filterRuntimeEnv({
      GITHUB_TOKEN: "ghp_x", MY_APP_FLAG: "true",
      AWS_SECRET_ACCESS_KEY: "secret", AWS_ACCESS_KEY_ID: "AKIA...",
      LOG_LEVEL: "debug",
    });
    expect(out).toEqual({});
  });

  it("DROPS all PANGOLIN_* control-plane vars (not in allow-list)", () => {
    const out = filterRuntimeEnv({
      PANGOLIN_DISPATCH_ID: "d-1",
      PANGOLIN_CALLBACK_TOKEN_REF: "arn:...:hmac",
      PATH: "/usr/bin",
    });
    expect(Object.keys(out).filter((k) => k.startsWith("PANGOLIN_"))).toEqual([]);
    expect(out.PATH).toBe("/usr/bin");
  });

  it("passes operator allow-list exact names", () => {
    const out = filterRuntimeEnv(
      { MY_APP_FLAG: "true", OTHER: "x" },
      { allow: ["MY_APP_FLAG"] },
    );
    expect(out).toEqual({ MY_APP_FLAG: "true" });
  });

  it("passes operator allow-list PREFIX_* trailing-glob", () => {
    const out = filterRuntimeEnv(
      { MYAPP_FOO: "1", MYAPP_BAR: "2", OTHER: "x" },
      { allow: ["MYAPP_*"] },
    );
    expect(out).toEqual({ MYAPP_FOO: "1", MYAPP_BAR: "2" });
  });

  it("ignores empty/whitespace allow entries", () => {
    const out = filterRuntimeEnv({ FOO: "1" }, { allow: ["", "  "] });
    expect(out).toEqual({});
  });

  it("does not mutate the input object", () => {
    const input = { PANGOLIN_DISPATCH_ID: "d-1", PATH: "/usr/bin" };
    filterRuntimeEnv(input);
    expect(input).toEqual({ PANGOLIN_DISPATCH_ID: "d-1", PATH: "/usr/bin" });
  });
});
```

This DELETES the old `opts.deny` test and the old default-allow assertions (per the policy-tightening blast-radius lesson: update to satisfy the new rule, never loosen).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-worker test -- runtime-env-filter`
Expected: FAIL — current default-allow filter passes `GITHUB_TOKEN`/`MY_APP_FLAG`/`LOG_LEVEL` and rejects unknown `opts.allow`.

- [ ] **Step 3: Rewrite the filter**

Replace the entire body of `runtime-env-filter.ts` (keep a module header describing default-deny) with:

```typescript
// Worker→runtime env firewall (§7.7 blast-radius reduction).
//
// DEFAULT-DENY allow-list: the worker boots with its own process.env (the
// PANGOLIN_* control plane, ambient AWS task-role credentials, plus arbitrary
// deploy/system vars). Handing any of that to the prompt-injectable sub-agent
// is a leak surface. `filterRuntimeEnv` produces the BASE env for the runtime
// by passing ONLY: a fixed set of non-credential system vars (BUILTIN_ALLOW),
// the LC_* locale prefix, and an explicit operator passthrough (`opts.allow`,
// from PANGOLIN_RUNTIME_ENV_ALLOW). Everything else is dropped. Credentials
// the sub-agent genuinely needs (e.g. ANTHROPIC_API_KEY) arrive via an env
// bundle / per-dispatch secret, which is merged ON TOP of this base and is
// registered for redaction.
//
// MIGRATION: a deploy that relied on INHERITING an arbitrary user var into the
// agent must now add it to PANGOLIN_RUNTIME_ENV_ALLOW or supply it via an env
// bundle. Proxied / custom-CA deploys must allow NODE_EXTRA_CA_CERTS and/or
// HTTP_PROXY/HTTPS_PROXY/NO_PROXY explicitly. (git is unaffected: patch-capture
// spawns git with the worker's own unfiltered process.env, not this base.)

/** Non-credential system vars always allowed into the child runtime env. */
const BUILTIN_ALLOW: ReadonlySet<string> = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL",
  "LANG", "LANGUAGE", "TZ", "TERM",
  "TMPDIR", "TMP", "TEMP", "NODE_ENV",
  "AWS_REGION", "AWS_DEFAULT_REGION",
]);

/** Built-in prefix allow (covers LC_ALL, LC_CTYPE, …). */
const BUILTIN_ALLOW_PREFIXES: ReadonlyArray<string> = ["LC_"];

export interface FilterRuntimeEnvOpts {
  /**
   * Operator passthrough allow-list. Each entry is either an exact variable
   * name or a `PREFIX_*` trailing-glob (prefix match on the part before `*`).
   * Empty/whitespace entries are ignored.
   */
  allow?: string[];
}

function matchesAllow(key: string, allow: ReadonlyArray<string>): boolean {
  for (const raw of allow) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    if (entry.endsWith("*")) {
      if (key.startsWith(entry.slice(0, -1))) return true;
    } else if (key === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Return a copy of `env` containing only the variables allowed into the AI
 * runtime: BUILTIN_ALLOW names, the LC_* prefix, and `opts.allow` matches.
 * Everything else (PANGOLIN_*, AWS credentials, arbitrary user vars) is
 * dropped. The input object is not mutated.
 */
export function filterRuntimeEnv(
  env: Record<string, string>,
  opts: FilterRuntimeEnvOpts = {},
): Record<string, string> {
  const allow = opts.allow ?? [];
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      BUILTIN_ALLOW.has(key) ||
      BUILTIN_ALLOW_PREFIXES.some((p) => key.startsWith(p)) ||
      matchesAllow(key, allow)
    ) {
      out[key] = value;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the filter test to verify it passes**

Run: `pnpm --filter @quarry-systems/pangolin-worker test -- runtime-env-filter`
Expected: PASS.

- [ ] **Step 5: Add the config field + parser test**

In `env-parser.test.ts`, add:

```typescript
it("parses PANGOLIN_RUNTIME_ENV_ALLOW into a trimmed string array", () => {
  const cfg = parseWorkerEnv({
    ...baseEnv(), // the file's existing required-env helper
    PANGOLIN_RUNTIME_ENV_ALLOW: " FOO , BAR_* , ,BAZ ",
  });
  expect(cfg.runtimeEnvAllow).toEqual(["FOO", "BAR_*", "BAZ"]);
});

it("defaults runtimeEnvAllow to [] when unset", () => {
  const cfg = parseWorkerEnv(baseEnv());
  expect(cfg.runtimeEnvAllow).toEqual([]);
});
```

(`baseEnv()` is the existing helper in `env-parser.test.ts` that returns the four required
`PANGOLIN_*` vars: DISPATCH_ID, NAMESPACE, STORAGE_URI, BUNDLE_REFS_JSON.)

- [ ] **Step 6: Run parser test to verify it fails, then implement**

Run: `pnpm --filter @quarry-systems/pangolin-worker test -- env-parser`
Expected: FAIL — `runtimeEnvAllow` undefined.

In `env-parser.ts`: add to the `WorkerConfig` interface:

```typescript
  /**
   * Operator passthrough allow-list for the runtime env firewall (exact names
   * or `PREFIX_*` globs). Parsed from PANGOLIN_RUNTIME_ENV_ALLOW (comma-sep).
   * Empty when unset.
   */
  runtimeEnvAllow: string[];
```

In `parseWorkerEnv`, before the `return`, add:

```typescript
  const runtimeEnvAllow = (env.PANGOLIN_RUNTIME_ENV_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
```

And add `runtimeEnvAllow,` to the returned object.

Run again: `pnpm --filter @quarry-systems/pangolin-worker test -- env-parser` → Expected: PASS.

- [ ] **Step 7: Wire `allow` into the entrypoint + fix the stale assertion**

`entrypoint.ts:401` — change:

```typescript
  const baseEnv = filterRuntimeEnv(rawBase, { allow: cfg.runtimeEnvAllow });
```

`entrypoint.test.ts:433` — the `LOG_LEVEL` var is now dropped by default-deny. Replace:

```typescript
    expect(captured!.LOG_LEVEL).toBe('debug');
```

with:

```typescript
    // Default-deny: LOG_LEVEL is not a built-in and was not allow-listed.
    expect(captured).not.toHaveProperty('LOG_LEVEL');
```

(Leave the `AWS_REGION` assertion at :432 — it is a built-in and still passes.)

- [ ] **Step 8: Run the full worker suite**

Run: `pnpm --filter @quarry-systems/pangolin-worker test`
Expected: PASS. If any other test asserted an inherited non-builtin var reaching the agent, update it to either drop the var or stage it via `PANGOLIN_RUNTIME_ENV_ALLOW` — never re-add it to `BUILTIN_ALLOW` to make an old assertion pass.

- [ ] **Step 9: Commit**

```bash
git add packages/pangolin-worker/src/runtime-env-filter.ts packages/pangolin-worker/src/env-parser.ts packages/pangolin-worker/src/entrypoint.ts packages/pangolin-worker/test/
git commit -m "fix(worker): env firewall default-deny allow-list + operator passthrough (F2)"
```

---

### Task 6: F6 — route channel-loader diagnostics through the redactor

**Files:**
- Modify: `packages/pangolin-worker/src/channel-loader.ts` (add a log hook; replace 3 `console.error`)
- Modify: `packages/pangolin-worker/src/entrypoint.ts:449-452` (pass the logger)
- Test: `packages/pangolin-worker/test/channel-loader.test.ts` (or the closest existing channel test)

- [ ] **Step 1: Write the failing test**

Add a test asserting a channel-adapter iteration error containing a secret is emitted through the injected log hook (redactable), not `console.error`. Use a fake adapter on disk whose `subscribe` yields then throws an error containing a marker, pass a capturing `logEvent`, and assert the marker reached `logEvent` (and that `console.error` was not used for it).

```typescript
import { describe, it, expect, vi } from "vitest";
// ...existing imports + an on-disk fake adapter whose iterator.next() rejects
//    with new Error("auth failed amqps://user:SECRETPW@host")...

it("emits channel iteration errors through the injected log hook, not console (F6)", async () => {
  const events: Array<{ kind: string; [k: string]: unknown }> = [];
  const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const handle = await loadChannelIfPresent({
    workspaceDir, // a workspace containing pangolin-channel.json for the fake adapter
    adaptersRoot,
    logEvent: (e) => events.push(e),
  });
  // give the background drain a tick to hit the throwing iterator
  await new Promise((r) => setTimeout(r, 20));
  await handle?.stop();
  consoleSpy.mockRestore();

  const channelErr = events.find((e) => e.kind === "channel.error");
  expect(channelErr).toBeDefined();
  expect(String(channelErr?.detail)).toContain("auth failed");
});
```

(Adapt `workspaceDir`/`adaptersRoot` setup to the existing channel-loader test harness — grep the test dir for `loadChannelIfPresent` to find the on-disk fake-adapter helper.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-worker test -- channel-loader`
Expected: FAIL — `logEvent` is not a known option and errors go to `console.error`.

- [ ] **Step 3: Add the log hook + replace console.error**

In `channel-loader.ts`, extend `LoadChannelOpts`:

```typescript
export interface LoadChannelOpts {
  workspaceDir: string;
  /** Override the adapters root for testing. Default: '/opt/pangolin/adapters'. */
  adaptersRoot?: string;
  /**
   * Redacting log sink. When provided, channel diagnostics are emitted through
   * it (so the worker's StructuredLogger redaction applies) instead of raw
   * `console.error`. Optional so standalone/tests still work.
   */
  logEvent?: (event: { kind: string; [k: string]: unknown }) => void;
}
```

Add a resolver near the top of `loadChannelIfPresent`:

```typescript
  const logErr = (event: { kind: string; [k: string]: unknown }): void => {
    if (opts.logEvent) opts.logEvent(event);
    // eslint-disable-next-line no-console
    else console.error(JSON.stringify(event));
  };
```

Replace the three `console.error(...)` sites:
- lines 86-89 →
  ```typescript
        logErr({ kind: "channel.error", adapter: cfg.adapter, detail: String(err) });
        return;
  ```
- lines 97-99 →
  ```typescript
        logErr({ kind: "channel.append-failed", inboxPath, detail: String(err) });
  ```
- lines 109-111 →
  ```typescript
    logErr({ kind: "channel.crashed", adapter: cfg.adapter, detail: String(err) });
  ```

(Remove the now-unneeded `// eslint-disable-next-line no-console` comments at those three sites.)

- [ ] **Step 4: Pass the logger from the entrypoint**

`entrypoint.ts:449-452` — change the call to:

```typescript
    channel = await loadChannelIfPresent({
      workspaceDir,
      adaptersRoot: deps.adaptersRoot,
      logEvent: (event) => logger.log(event),
    });
```

(`logger` is the `StructuredLogger` already in scope here — it redacts registered secrets.)

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @quarry-systems/pangolin-worker test -- channel-loader`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/pangolin-worker/src/channel-loader.ts packages/pangolin-worker/src/entrypoint.ts packages/pangolin-worker/test/
git commit -m "fix(worker): route channel-loader diagnostics through the redactor (F6)"
```

---

### Task 7: F3 — plugin-installer capture+throw instead of `stdio:"inherit"`

**Files:**
- Modify: `packages/pangolin-runtime-claude-code/src/plugin-installer.ts`
- Test: `packages/pangolin-runtime-claude-code/test/plugin-installer.test.ts` (or closest existing)

**Harness note (from plan audit):** `plugin-installer.test.ts` has a top-level
`vi.mock("node:child_process")` (~lines 10-42) that intercepts EVERY `spawn`, returning a bare
`EventEmitter` that emits only `"exit"` (no `.stdout`/`.stderr`). A real stub script will never
run, and spying `process.stdout.write` against a mock proves nothing. So we (a) extend the mock to
emit configurable stdout/stderr data + an exit code, and (b) assert the no-raw guarantee
structurally via the recorded `stdio` argument.

- [ ] **Step 1: Extend the child_process mock**

Replace the file's `vi.mock("node:child_process", ...)` factory with one that carries streams +
config (keep `EventEmitter` import):

```typescript
vi.mock("node:child_process", () => {
  const calls: Array<{ bin: string; args: string[]; stdio: unknown }> = [];
  const config = { nextExitCode: 0, nextStdout: "", nextStderr: "" };
  function spawn(bin: string, args: string[], opts: { stdio?: unknown } = {}) {
    calls.push({ bin, args, stdio: opts.stdio });
    const ee = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    setImmediate(() => {
      if (config.nextStdout) ee.stdout.emit("data", Buffer.from(config.nextStdout));
      if (config.nextStderr) ee.stderr.emit("data", Buffer.from(config.nextStderr));
      ee.emit("exit", config.nextExitCode);
    });
    return ee;
  }
  return { spawn, __calls: calls, __config: config,
    __reset: () => { calls.length = 0; Object.assign(config, { nextExitCode: 0, nextStdout: "", nextStderr: "" }); } };
});
```

Add a `beforeEach` (or per-test) call to `(await import("node:child_process") as any).__reset()`
if the existing tests need a clean slate. Confirm the existing success/manifest-absent/non-array/
non-zero tests still pass against this richer mock (they emit `exit` with code 0 by default; the
non-zero tests set `__config.nextExitCode`). Adjust those existing tests minimally if they
asserted on the old mock's exact shape.

- [ ] **Step 2: Write the failing F3 test**

```typescript
it("captures install output and throws with it on failure; never inherits stdio (F3)", async () => {
  const cp = (await import("node:child_process")) as unknown as {
    __config: { nextExitCode: number; nextStdout: string };
    __calls: Array<{ stdio: unknown }>;
  };
  cp.__config.nextStdout = "marker-OUTPUT-123";
  cp.__config.nextExitCode = 3;

  const chunks: string[] = [];
  await expect(
    installPluginsFromManifest({
      workspaceDir, env: {}, claudeBin: "claude",
      onOutput: (c) => chunks.push(c.text),
    }),
  ).rejects.toThrow(/plugins install .*code 3/s);

  // Output captured via onOutput, and the thrown error carries it.
  expect(chunks.join("")).toContain("marker-OUTPUT-123");
  // Structural no-raw guarantee: stdio is piped/ignored, never "inherit".
  expect(cp.__calls.at(-1)!.stdio).toEqual(["ignore", "pipe", "pipe"]);
});
```

(`workspaceDir` must contain `pangolin-plugins.json` = `["p"]`; reuse the existing tests'
workspace-setup helper so the manifest is present.)

- [ ] **Step 2b: Run test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-runtime-claude-code test -- plugin-installer`
Expected: FAIL — `onOutput` unknown; `stdio` recorded as `"inherit"`; error lacks captured output.

- [ ] **Step 3: Rewrite the spawn to capture + throw**

In `plugin-installer.ts`, extend the options and replace the spawn block:

```typescript
export interface InstallPluginsOptions {
  workspaceDir: string;
  env: Record<string, string>;
  claudeBin?: string;
  /**
   * Test/diagnostic hook for captured child output. Production callers omit it
   * (success output is discarded; failure output rides the thrown error, which
   * the worker logs through its redactor). Never written raw to fd1/fd2.
   */
  onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
}
```

Replace the `await new Promise<void>(...)` body inside the loop:

```typescript
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, ["plugins", "install", name], {
        cwd: opts.workspaceDir,
        env: opts.env,
        // F3: capture, never inherit — the merged env carries secrets and the
        // child's output must not reach the worker's fds unredacted.
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout?.on("data", (d: Buffer | string) => {
        const text = typeof d === "string" ? d : d.toString();
        out += text;
        opts.onOutput?.({ stream: "stdout", text });
      });
      child.stderr?.on("data", (d: Buffer | string) => {
        const text = typeof d === "string" ? d : d.toString();
        err += text;
        opts.onOutput?.({ stream: "stderr", text });
      });
      child.on("exit", (code: number | null) => {
        if (code === 0) {
          resolve();
        } else {
          const tail = `${out}${err}`.trim();
          reject(
            new Error(
              `claude plugins install ${name} exited with code ${code}` +
                (tail ? `: ${tail}` : ""),
            ),
          );
        }
      });
      child.on("error", (e: Error) => {
        reject(
          new Error(`claude plugins install ${name} failed to spawn: ${e.message}`),
        );
      });
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @quarry-systems/pangolin-runtime-claude-code test -- plugin-installer`
Expected: PASS. Confirm any pre-existing plugin-installer tests (manifest absent no-op, non-array throw, success path) still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/pangolin-runtime-claude-code/src/plugin-installer.ts packages/pangolin-runtime-claude-code/test/
git commit -m "fix(runtime): capture+redact plugin-install output instead of stdio:inherit (F3)"
```

---

### Task 8: Full gate

- [ ] **Step 1: Typecheck the workspace**

Run: `pnpm -r typecheck`
Expected: PASS (catches any caller broken by the new required `runtimeEnvAllow` field, the `FilterRuntimeEnvOpts` change, or the `InstallPluginsOptions` change).

- [ ] **Step 2: Test the workspace**

Run: `pnpm -r test`
Expected: PASS. This is the net for stale runtime assertions per the policy-tightening blast-radius lesson — fix any failure by satisfying the new rule (stage/allow/sign legitimately), never by loosening an assertion.

- [ ] **Step 3: Lint each touched package**

Run: `pnpm --filter @quarry-systems/pangolin-worker lint && pnpm --filter @quarry-systems/pangolin-secret-store lint && pnpm --filter @quarry-systems/pangolin-client lint && pnpm --filter @quarry-systems/pangolin-providers-local-docker lint && pnpm --filter @quarry-systems/pangolin-runtime-claude-code lint`
Expected: PASS.

- [ ] **Step 4: Commit any lint fixups, then open the PR** (handled by the campaign driver).

---

## Self-review

- **Spec coverage:** F1=Task4, F2=Task5, F3=Task7, F6=Task6, F9=Task3, F10=Task1, F12=Task2. All seven covered. Key-custody decision is a separate vault page (not in this plan, by design).
- **Placeholders:** none — every code step shows the code. The two "adapt to existing harness" notes (F9 bind test, F6/F3 stub setup) point at concrete existing patterns in the repo and give the exact assertions.
- **Type consistency:** `runtimeEnvAllow: string[]` (env-parser) → `filterRuntimeEnv(rawBase, { allow: cfg.runtimeEnvAllow })` (entrypoint) → `FilterRuntimeEnvOpts.allow?: string[]` (filter). `onOutput?: (chunk:{stream,text})` consistent between `InstallPluginsOptions` and the test. `logEvent?: (event:{kind,...})` consistent between `LoadChannelOpts` and the entrypoint call. Consistent.
