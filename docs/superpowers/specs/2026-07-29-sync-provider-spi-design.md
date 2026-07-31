# Sync provider SPI — out-of-tree provider authoring

**Status:** design proposed 2026-07-29 · revised post-audit 2026-07-29 · **Author:** agent:claude-opus-5 (with Brett) · **Confidence:** high

Make `SyncProvider` implementable and registerable from outside the pangolin
repo. Two changes, both load-bearing: publish a provider-authoring surface so a
third party can *write* a provider, and add a `syncProviders` named export on
`pangolin.config.{ts,js,mjs}` so they can *register* it. Either alone leaves the
capability unreachable.

**Evidence discipline for this spec.** Every factual claim about current
behavior carries a `file:line` citation. Claims about what *will* exist are
marked as decisions, not descriptions. §10 (documentation) may only describe
surface that lands in the same change.

---

## 1. Context

### 1.1 The pull

A consumer (remora) has an on-disk agent convention that Pangolin cannot sync.
Their layout is `agents/<name>.md`, where a bare `\n---\n` separates a header
from the prompt body, and the body is a Mustache template containing
`{{instructions}}`.

The contract already expresses this. `SubagentDef`
(`packages/pangolin-cli/src/providers/types.ts:19-31`) carries both
`promptTemplate` and `systemPrompt`. The runtime honors the distinction:
`renderPrompt` (`packages/pangolin-runtime-claude-code/src/prompt-renderer.ts:26-34`)
Mustache-renders `promptTemplate` when it is a non-empty string and otherwise
returns `systemPrompt` **verbatim**. So a convention whose prompts contain
`{{instructions}}` must land in `promptTemplate`, or the placeholder reaches the
model as literal text.

The shipped provider cannot do that. `ClaudeCodeProvider.loadSubagents`
hardcodes `{ name, systemPrompt: body }`
(`packages/pangolin-cli/src/providers/claude-code.ts:43`) with no seam to opt
out. `StoaProvider` hardcodes the same field
(`packages/pangolin-cli/src/providers/stoa.ts:70`). Both shipped providers make
the same choice and neither exposes it.

A `--prompt-field` flag on `claude-code` would address one of four differences.
Remora also differs in separator convention (bare `\n---\n` with no leading
delimiter, which `splitFrontmatter` rejects outright —
`packages/pangolin-cli/src/frontmatter.ts:15-21`), default directories
(`agents/` and `capabilities/` at repo root, not `.claude/*`), and
provider-specific validation (`{{instructions}}` presence, stray-placeholder
rejection). A distinct provider is the right unit.

**Grounding limit.** No `RemoraProvider` exists in this repo, so the four
differences above are the consumer's description of an external codebase, not a
verified claim. Partial corroboration:
`deploy/serve-stack/client/submit-concerns-probe.mjs:19-35` (untracked) reads
`remora/agents/dag-implementer.md`, hand-builds a `promptTemplate`, and submits it
via `pangolin-client` directly (`:65-69`) — confirming the `agents/<name>.md`
layout and the
`promptTemplate` need, and standing as a live instance of the reimplementation
path §1.2 warns about. It does not confirm the separator convention or the
validation rules.

### 1.2 Blocker one — the registry is closed

`PROVIDERS` is a module-level `const` with two hardcoded entries
(`packages/pangolin-cli/src/providers/index.ts:11-14`). `resolveProvider`
(`:16-23`) reads only that map. There is no dynamic loading.

The documentation states the consequence plainly. The "Authoring a new sync
provider" section of
`docs-site/src/content/docs/how-to/sync-capabilities-subagents.md:136-171`
walks through implementing the interface and then instructs the reader:

> To register a provider, add an entry to the `PROVIDERS` map in
> `packages/pangolin-cli/src/providers/index.ts`

That instruction is only actionable if the reader *is* pangolin. Every
out-of-tree convention's remaining options are to fork the CLI or to reimplement
registration directly against `pangolin-client` — and the reimplementation path
is worse for Pangolin, because it routes integrators around the `cmd-*` layer
that owns registration UX and lands them on the client.

### 1.3 Blocker two — nothing is importable

`packages/pangolin-cli/src/index.ts` exports exactly five things: `CliContext`,
`buildProgram`, `defaultGetClient`, `defaultGetOrchContext`, `formatCliError`
(`:23`, `:32`, `:46`, `:71`, `:99`). Nothing from `./providers/` is re-exported.
`package.json` declares `main` and `types` (`:6-7`) and no `exports` map.

So both lines of a minimal out-of-tree provider fail against the published
package:

| Line | Why it fails |
|---|---|
| `implements SyncProvider` | Type is exported at `providers/index.ts:29` but that module is unreachable from the package root |
| `new ClaudeCodeProvider()` | Never exported as a value from any public path |

The second matters more than it looks. Composition-over-inheritance is the
house pattern — `StoaProvider` holds a `ClaudeCodeProvider` (`stoa.ts:36`) and
delegates `loadCapabilities` wholesale (`:79-81`), which is why it is ~110 lines
instead of ~240. An out-of-tree provider that cannot compose must reimplement
the SKILL.md walk (`claude-code.ts:50-72` plus helpers `:90-177`).

A deep import of `dist/providers/index.js` resolves today, because absent an
`exports` map there is no encapsulation and `dist` is in `files`
(`package.json:11-15`). That is an unsupported path into build output which
breaks the moment an `exports` map is added.

### 1.4 Why the trust argument permits this

`pangolin.config` already executes arbitrary code with full credentials — it
constructs the `PangolinClient`, secret stores included (`index.ts:59-66`). A
`syncProviders` export therefore cannot escalate anything: whoever can write
that file already owns the process. Nor does it widen *where* third-party code
runs. A config that does `import { RemoraProvider } from '…'` evaluates that
module today, whether or not a `syncProviders` export exists to receive it.

**Two processes import this file, not one.** `packages/pangolin-mcp/src/bin.ts:14-49`
is a third, independent copy of the same resolution loop, and it runs
unconditionally at MCP server startup (`:53-58`, exiting the process on
rejection). It reads only `mod.default ?? mod.client` (`:29`) and `mod.orch`
(`:41`) — `syncProviders` is ignored there — but the *module body* is evaluated
in the MCP process regardless. That is true today and this change does not alter
it; the earlier framing of this section as "at CLI time" was wrong and is
corrected here. See §7 for why that copy stays.

This is the reason to prefer the config over the alternatives. A
`--provider-module <path>` flag or an npm plugin-discovery convention would each
open a *new* code-loading path requiring its own trust analysis. The config
reuses one already-audited boundary and adds zero surface.

The relationship to ADR-0005
(`docs-site/src/content/docs/explanation/decisions/0005-privileged-ops-never-ai-reachable.md`)
is consistency, not enforcement. ADR-0005's enforcement is a CI check asserting
the `pangolin-mcp` tool surface equals a frozen allowlist (`:71-79`). Note the
ADR's stated count is itself stale — it says "exactly six", while
`packages/pangolin-mcp/src/tools.ts:41-50` registers **nine**
(`PANGOLIN_TOOL_NAMES`, the six run-time tools plus three orchestrator tools),
which `docs-site/src/content/docs/explanation/privilege-boundary.md:45-59`
already reflects. That drift is a pre-existing defect in the ADR, not something
this change introduces, and none of the nine is sync-related.

Nothing here touches that check: `sync` remains CLI-only, providers never become
invokable from `pangolin-mcp` or a dispatched worker, and the artifact-creation
surface stays out of the AI loop. The claim this spec makes is that the change
does not weaken the boundary — not that it strengthens it.

---

## 2. Decisions

| # | Decision |
|---|---|
| D1 | Publish a provider-authoring SPI at the `./providers` subpath, adding an `exports` map |
| D2 | `syncProviders` is a named export on `pangolin.config.{ts,js,mjs}`, typed `SyncProvider[]` |
| D3 | A config provider colliding with a built-in name is a hard error; no shadowing |
| D4 | Config is loaded **lazily — only when the requested provider is not a built-in** |
| D5 | `resolveProvider` stays synchronous and pure; the extras are passed in |
| D6 | Config-supplied providers are shape-validated inside `mergeProviders`, the one point every path crosses |
| D7 | A missing config file, a missing export, or `undefined` yields no extras, never an error |
| D8 | Registry internals move to `providers/registry.ts`; `providers/index.ts` becomes a pure SPI barrel |
| D9 | The SPI ships explicitly provisional, not semver-committed |
| D10 | The two in-package config-resolution copies collapse to one helper; the `pangolin-mcp` copy stays |

---

## 3. The SPI surface (D1, D8)

### 3.1 Package exports

`packages/pangolin-cli/package.json` gains an `exports` map. `main` and `types`
stay for older resolvers.

```json
"exports": {
  ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./providers": {
    "types": "./dist/providers/index.d.ts",
    "default": "./dist/providers/index.js"
  }
}
```

This is the **first `exports` map in the monorepo** — the other fifteen packages
declare `main`/`types` only. The divergence is deliberate: `pangolin-cli` is the
only package publishing a second entry point, and a subpath without an `exports`
map cannot be declared at all.

A single `"default"` condition is correct even though consumers are ESM and the
package emits CommonJS. tsc's re-export emit
(`Object.defineProperty(exports, "X", { enumerable: true, get: … })`) is
detected by `cjs-module-lexer`, so `import { ClaudeCodeProvider } from
'@quarry-systems/pangolin-cli/providers'` resolves named bindings from an
`.mjs` config. **Do not add a `require`/`import` condition split.** This was
verified by reproducing tsc's emit shape and importing it from `.mjs`; §9 pins
it against real build output.

### 3.2 Barrel split (D8)

`providers/index.ts` currently mixes the registry with the type barrel. Under an
`exports` map, everything it exports becomes public API by placement — including
`PROVIDERS`-backed internals that D9's "provisional SPI" claim is not meant to
cover.

| File | Contents | Visibility |
|---|---|---|
| `providers/registry.ts` *(new)* | `PROVIDERS`, `findBuiltIn`, `resolveProvider`, `resolveProviderLazily`, `mergeProviders`, `listProviderNames`, `ConfigProviders` | internal — imported by `cmd-*` and `src/index.ts` only |
| `providers/index.ts` | the three types, `ClaudeCodeProvider`, `StoaProvider`, `splitFrontmatter` | **the published SPI, and nothing else** |

The shape check is a **module-private helper inside `registry.ts`**, not an
export. D6 puts it inside `mergeProviders`; giving it a second, independently
callable entry point would reintroduce the bypass D6 exists to close. This table
is the authority on placement — where prose elsewhere disagrees, the table wins.

`cmd-subagent.ts:20` and `cmd-capabilities.ts:21` change their import path
accordingly.

The asymmetry that justifies erring narrow: adding an export to a published
subpath later is non-breaking; removing one is not.

**`splitFrontmatter` is exported despite being unusable by the motivating
consumer.** Remora's bare `\n---\n` has no leading delimiter, and
`frontmatter.ts:19-21` throws on anything the leading-`---` regex
(`frontmatter.ts:15`) does not match. It is exported because both in-tree
providers depend on it (`claude-code.ts:38`, `stoa.ts:66`) and any convention
that *does* use YAML frontmatter would otherwise reimplement it. If that
rationale does not hold at implementation time, drop it — it is the one export
here with no consumer proving it out.

### 3.3 Why a subpath rather than a root re-export

The root entry is the bin itself — shebang at `index.ts:1`, commander wiring in
`buildProgram` (`:32-44`), direct-invocation guard at `:109-110`. A type-only
import of `SyncProvider` erases at compile time and would cost nothing, but
`ClaudeCodeProvider` is a value import and would drag the whole
program-construction graph.

**Known risk.** Adding an `exports` map where none existed makes
previously-resolvable deep imports fail. The `"."` entry must be declared or
every existing root import breaks. No in-repo consumer deep-imports
`pangolin-cli`; `bin` resolution is by file path and unaffected; the only
in-repo casualty is a stale comment at `examples/manifest/test/deploy.test.ts:26`.
External deep importers are possible but unsupported today and unknowable from
inside the repo.

---

## 4. Registration and resolution (D2, D3, D4, D5)

### 4.1 Config shape

```ts
// pangolin.config.ts
import { RemoraProvider } from 'remora-pangolin-provider';
export const syncProviders = [new RemoraProvider()];
```

`SyncProvider[]`, not a `Map`. `name` is already `readonly` on the interface
(`providers/types.ts:40`); a keyed map would duplicate it and invite key/name
disagreement.

npm is the distribution point, the config is the registration point. A provider
may equally be a local file in the deploy repo.

### 4.2 Lazy resolution (D4)

**Built-ins resolve without importing the config at all.** Only a built-in miss
triggers the import. Both actions use the §4.6 helper:

```ts
const provider = await resolveProviderLazily(opts.provider, ctx.getSyncProviders);
```

The property this buys is narrower than "`--dry-run` performs no config I/O", and
the narrower statement is the accurate one: **a built-in provider under
`--dry-run` performs no config I/O.** Enumerated, the config *is* imported by:

| Invocation | Imports config? | Why |
|---|---|---|
| built-in, `--dry-run` | **no** | built-in hit; client skipped at `cmd-subagent.ts:125` / `cmd-capabilities.ts:60` |
| built-in, real run | yes | `getClient()` → `defaultGetClient` → `index.ts:59` |
| config provider, either mode | yes | built-in miss → `getSyncProviders()` |
| **a typo'd provider name**, either mode | yes | a typo is a built-in miss |

That last row is a real cost: `--provider claude-cod` against a throwing config
reports a module-resolution error instead of
`unknown --provider 'claude-cod' (known: …)`, losing the §4.4 discoverability
affordance exactly when it is needed. Accepted; the alternative is eager loading,
which loses it on every invocation.

Eager loading would have been worse because config bodies are not inert:
`examples/offload-fanout/pangolin.config.mjs:63` opens a SQLite file and `:66`
registers a `process.on('exit')` hook, despite the `IMPORT-SAFE` comment at
`:61`, which means only "does not throw". `IMPORT-SAFE` is a hand-maintained
comment convention, not a mechanism, and binds no external config. (Note
`defaultGetClient` is not the only config toucher — `defaultGetOrchContext`
(`index.ts:71-94`) is a second, and `pangolin-mcp` a third; see §7.)

**Consequence for D3, accepted deliberately.** Collision detection now fires only
on invocations that consult the config. A config declaring `claude-code` goes
unreported until someone runs a config-provided provider. This costs nothing
substantive: built-ins are checked first by construction, so a colliding config
entry can never take effect, and D3's error is diagnostic rather than protective.

**Consequence for a broken config.** Stated precisely, because the scope is wider
than the sync command: a config that throws on import breaks **every invocation
that constructs a client, plus `pangolin-mcp` startup** (`bin.ts:28`, invoked
unconditionally at `:53-58` with `process.exit(1)` on rejection). Only a built-in
under `--dry-run` survives it. Lazy loading narrows *this command's* exposure; it
does not make a broken config safe.

**This is why §10 must state an import-safety requirement for provider authors.**
The SPI is the thing that creates a reason to `import` a third-party package into
`pangolin.config`, and that file is evaluated inside the MCP server. A provider
package that is a `devDependency`, absent from a pruned production install, or
throwing at module scope takes down `pangolin-mcp` — a process that does not
expose `sync` at all.

### 4.3 Merge semantics (D3)

```ts
export function mergeProviders(
  extra: unknown,          // the raw export — the array check is step 2 of §5
  source: string,
): ReadonlyMap<string, SyncProvider>;
```

`source` is the config filename — **`pangolin.config.ts`, `.js`, or `.mjs`,
whichever actually resolved**, not a hardcoded literal. Its producer is the
`filename` that `loadConfigModule` already has in scope (§7); the seam carries it
out (§4.5) so the errors below can name the file the operator actually has. All
three resolution legs are supported, so a hardcoded `'pangolin.config.mjs'` would
misreport in any repo using the other two.

Built-ins seed the map; each validated `extra` entry is added by its own `name`.
Three error cases, all thrown at merge time:

- an entry fails validation (§5)
- an entry's name collides with a built-in (`claude-code`, `stoa`)
- two entries share a name

D3 makes collision an error rather than a precedence rule, so there is no silent
shadowing to explain in a support thread. `sync` ends in `subagent.register()`
(`cmd-subagent.ts:131`) and `capabilities.register()` (`cmd-capabilities.ts:66`)
— deploy-time privileged operations per ADR-0005 — and an override that silently
changed what got registered would be legible nowhere. Overriding a built-in is
served by defining a distinct name.

Collision errors name **both** sides: the colliding name, the config file, and
the array index of the offending entry.

### 4.4 Resolution surface (D5)

```ts
export function findBuiltIn(name: string): SyncProvider | undefined;
export function resolveProvider(name: string, extra: unknown, source: string): SyncProvider;
```

`resolveProvider` delegates to `mergeProviders` and stays synchronous — the only
async step is `resolveProviderLazily`'s `await getExtra()` (§4.6), so the merge
and lookup core stays pure and directly unit-testable. Its unknown-provider error
(`providers/index.ts:20`) enumerates config providers too, so `--provider remora`
in a repo whose config defines it never reports `known: claude-code, stoa`. The
enumeration is deterministic: Map insertion order, built-ins first.

`listProviderNames` (`providers/index.ts:25`) **moves to `registry.ts` unchanged**
— same body, same signature, new home per §3.2. It has zero callers anywhere in
`packages/**/src` (only its own definition and the generated
`dist/providers/index.d.ts:3`), so widening it would be speculative. Moving it
rather than leaving it is forced: under §3.2 `providers/index.ts` *is* the
published barrel, so a function that stays there is published.

### 4.5 Wiring (D5)

`CliContext` (`index.ts:23-30`) gains a third seam. It carries the filename with
the data, so `source` has a producer (§4.3):

```ts
export interface ConfigProviders {
  /** The raw `syncProviders` export, unvalidated — including "not an array". */
  providers: unknown;
  /** The config filename that actually resolved. */
  source: string;
}

getSyncProviders: () => Promise<ConfigProviders | null>;   // null = no config file
```

`providers` is `unknown`, not `SyncProvider[]` and **not `readonly unknown[]`**.
`SyncProvider[]` would assert validated data at precisely the point §5 says is not
yet validated. `readonly unknown[]` is subtler and equally wrong: it cannot hold
`null`, so the loader would have to reject `null` itself — moving a validation
step out of `mergeProviders` and breaking D6's "one point every path crosses".
The array check is §5 step 2's job, so the value must reach it un-narrowed.
`mergeProviders` therefore takes `unknown` as well.

**The sole real construction site is `index.ts:110`**, which today passes
`{ getClient: defaultGetClient, getOrchContext: defaultGetOrchContext }`. It must
also pass `getSyncProviders: defaultGetSyncProviders`.

**What catches an omission, precisely.** The member is **required**, and
`index.ts:110` is inside `src/`, which `tsconfig.json:7` includes. So a missing
member is `TS2345` and fails `pnpm -r typecheck`
(`.github/workflows/typecheck.yml:49`) and `pnpm -r build`. **The compiler is the
guard, and it is the only one** — `:110` sits inside
`if (typeof require !== 'undefined' && require.main === module)` (`:109`), which
never executes under vitest, and `pangolin-cli` has no `tsconfig.test.json`, so
its fixtures are type-checked by nothing.

That asymmetry sets the repair rule below.

**Test fixtures in scope, and the required repair direction.**
`test/cmd-subagent.test.ts:126` constructs `{ getClient }` and invokes
`--provider made-up` (`:129`) — the suite's only built-in **miss**, so under §4.2
it reaches the new seam and throws `TypeError` instead of the
`unknown --provider 'made-up'` its `:131` assertion expects. **This change lands
`pnpm -r test` red there.** That is expected, and the repair is to **widen the
fixture** with a `getSyncProviders: async () => null`.

> **Do not** make the member optional, and **do not** call it with `?.`. Either
> silences the red test and simultaneously deletes the only thing protecting
> `index.ts:110`. In that state an unwired `:110` yields a silent `[]`,
> `--provider remora` reports `unknown --provider 'remora'` against a perfectly
> good config, and the entire suite is green. This is the repo's documented
> "green tests, dead runnable artifact" class
> (`.claude/audit-charter.md`, recurring bug classes).

`cmd-capabilities.test.ts:15,36,60` construct contexts the same way but only ever
pass `claude-code`, so they pass incidentally. Widen them too rather than relying
on that.

**Breaking-change obligation.** `CliContext` and `buildProgram` are published root
exports, so a required third member is a breaking change to the **root** surface —
which D9's provisional posture covers only for the `./providers` subpath. Under
the package's `0.4.0` pre-1.0 semver it lands on a minor bump, and it goes in
`CHANGELOG.md` under the existing `### Breaking` convention (`:12`), not as an
additive entry.

**Static help text stays generic.** Commander builds the program before any
config is loaded, so `--provider`'s help string (`cmd-subagent.ts:118`,
`cmd-capabilities.ts:53`) cannot enumerate config providers without eagerly
importing the config on every CLI invocation. Resolution happens at action time.

### 4.6 Shared resolve helper

The two-line resolve in §4.2 is identical in both actions, and its **ordering** is
the correctness-critical part — built-in first, config second. It lands in
`providers/registry.ts` as one function:

```ts
export async function resolveProviderLazily(
  name: string,
  getExtra: () => Promise<ConfigProviders | null>,
): Promise<SyncProvider>;
```

Behavior: return `findBuiltIn(name)` if it hits. On a miss, `await getExtra()` —
`null` (no config file) resolves against built-ins alone and throws the
unknown-provider error listing only those; otherwise merge via
`mergeProviders(providers, source)` and resolve from the merged map. `source` is
not a parameter here — it arrives with the data, which is the point of §4.5's
seam shape.

Taking a `getExtra` callback rather than a `CliContext` keeps `registry.ts` free
of any dependency on `src/index.ts`, so there is no import cycle.

**Deliberate divergence from the audit's proposal.** The audit suggested lifting
the whole action prologue into a `runProviderSync` in `sync.ts`. Rejected: the two
actions differ in their default-dir field, their `load*` method, and their register
callback — every parameter — so the shared unit would be a thin wrapper around
four injected differences. The resolve *is* the shared logic; the rest is
coincidental shape. `runSync` (`sync.ts:25`) already factors the genuinely shared
half.

---

## 5. Validation (D6, D7)

All eight tracked configs in the repo are `.mjs` — under
`examples/offload-minio/`, `examples/offload-fanout/`, `examples/handoff-dag/`,
`examples/demo-claims-appeals/`, `examples/demo-claims-appeals-minio/`,
`examples/dogfood-gated/`, `deploy/serve-stack/`, and
`deploy/serve-stack/client/`. Plain JavaScript, no typechecking. So
`export const syncProviders = [{ name: 'remora' }]` is accepted by the loader and
would fail later as `TypeError: provider.loadSubagents is not a function` inside a
command action.

Validation lives **inside `mergeProviders`** (D6) rather than in a separate pass,
and is not separately exported (§3.2). Every path that admits a config-supplied
provider — `resolveProviderLazily`, and any direct in-tree `resolveProvider` call
— goes through that one function, so "shape-validated before use" holds by
construction rather than by each caller remembering a validator step.

Order of checks, and the `undefined` case:

1. `undefined` — the export is absent — short-circuits to `[]` before validation
   (D7). It is not treated as a malformed value.
2. `null` and every other non-array value are **rejected**, naming the config
   file.
3. Each entry is rejected if it is not an object, or if `name` is not a non-empty
   string, or if `loadSubagents` / `loadCapabilities` / `defaultSubagentDir` /
   `defaultCapabilityDir` is missing or of the wrong type. These errors name the
   config file **and the array index**.

The two directory fields are validated unconditionally even though they are read
only when the corresponding `--from` is absent (`cmd-subagent.ts:123`,
`cmd-capabilities.ts:58`). They are non-optional on the interface
(`providers/types.ts:41-44`), and conditioning validation on a flag parsed later
would mean a malformed provider passes config load and fails only on the
invocation that happens to omit `--from`.

Hand-rolling this reinvents nothing: `pangolin-cli` has no schema library
(dependencies are `commander` and `yaml`), and the in-package idiom for exactly
this job is `manifest-parser.ts:33-90`.

The purity contract in `providers/types.ts:5-6` ("they read filesystem, they do
NOT call the PangolinClient") is a convention enforced by review for built-ins and
is unenforceable for third-party code; the validator checks shape, not behavior,
and the docs must not imply otherwise. Some downstream guards are real, and this
spec deliberately stays silent on them: a `SubagentDef` with neither prompt field
throws (`pangolin-client/src/subagent-register.ts:59-63`), names are
segment-checked (`pangolin-core/src/uri.ts:106`), and bundles are size-capped at
50 MiB (`pangolin-client/src/capabilities-register.ts:80-82`).

**Bundles are not credential-scanned on this path** — an earlier revision of this
spec claimed they were, and that was wrong. `capabilities-register.ts:84-88`
gates `assertNoCredentialPattern` on `typeof contents === 'string'`, and a
`CapabilityBundle`'s `files` is `Record<string, Uint8Array>`
(`providers/types.ts:35`), so the scanner never fires. The reference doc states
this correctly already
(`docs-site/src/content/docs/reference/pangolin-client-api.md:85` — "`Uint8Array`
values pass through unscanned"). This is pre-existing and identical on the manual
`capabilities register --from <dir>` path (`cmd-capabilities.ts:87` also produces
Buffers), so the SPI introduces no new hazard — but §10 must not repeat the false
claim.

---

## 6. Absent config is not an error (D7)

Three cases yield no extras rather than an error:

| Case | `getSyncProviders` returns |
|---|---|
| no `pangolin.config.*` in cwd | `null` |
| config present, no `syncProviders` export | `{ providers: [], source: <filename> }` |
| config present, export is `undefined` | `{ providers: [], source: <filename> }` |

The last two keep `source` because a config file does exist; the distinction is
immaterial to resolution (an empty `providers` merges to built-ins either way) but
keeps the seam honest about what it found. `null` means *no config file*, not *no
providers* — §5's `undefined` short-circuit and this are different mechanisms at
different layers.

This differs deliberately from `getOrchContext`, which throws when the `orch`
export is missing (`index.ts:86-90`) because orch verbs cannot run without it.
Sync verbs run fine on built-ins alone — and under D4 they do not even import the
config to find that out.

---

## 7. Config loader consolidation (D10)

Three copies of the same resolution loop exist today:

| Copy | Location |
|---|---|
| 1 | `packages/pangolin-cli/src/index.ts:46-69` (`defaultGetClient`) |
| 2 | `packages/pangolin-cli/src/index.ts:71-94` (`defaultGetOrchContext`) |
| 3 | `packages/pangolin-mcp/src/bin.ts:14-49` (`resolveConfig`) |

They share the filename triple, the `access` probe, and the `pathToFileURL`
import, differing only in which exports they read and the error strings.
`getSyncProviders` would be the fourth.

**Copies 1 and 2 collapse; copy 3 stays.** One helper in `pangolin-cli`, callers
keeping their own semantics:

```ts
async function loadConfigModule(): Promise<{ mod: Record<string, unknown>; filename: string } | null>;
```

Returns `null` when no config file exists. `defaultGetClient` and
`defaultGetOrchContext` throw their existing messages verbatim on `null`;
`defaultGetSyncProviders` returns `null`, and otherwise
`{ providers: mod.syncProviders ?? [], source: filename }`.

**The `filename` this helper already computes is what makes §4.3's `source` real.**
Today it is loop-local (`index.ts:52`) and interpolated only into error strings
before going out of scope; consolidating the loop is what gives it a single place
to escape from.

Copy 3 stays because sharing it would add a `pangolin-mcp` → `pangolin-cli`
package-graph edge that `docs-site/src/content/docs/reference/package-map.md`
does not show, to deduplicate fifteen lines. The honest fix is a pointer comment
in all three loaders and a line in `config.md` noting that two processes import
this file. Revisit only if a fourth out-of-package copy appears.

**Error strings are unchanged.** They are user-facing. Note the earlier claim
that "some are asserted in tests" was false — a repo-wide search finds zero
references under any `test/` directory; the only external pin is documentation at
`docs-site/src/content/docs/reference/config.md:23`. The four literals live at
`index.ts:63,68,88,93`. §9 pins them so the test sources from this spec rather
than from whatever the refactor produces.

---

## 8. Stability posture (D9)

The SPI ships **provisional**, and D9 scopes to the `./providers` subpath
specifically — the exports listed in §3.2, not the root surface (§4.5).
`pangolin-cli` is at `0.4.0` (`package.json:3`); pre-1.0 semver already permits
breaking changes on a minor bump, and freezing an interface on one out-of-tree
consumer is premature.

The named reason, to be stated in the docs: `loadSubagents(dir: string)` is
already overloaded. `ClaudeCodeProvider` treats `dir` as the directory containing
subagent files (`claude-code.ts:31-32`). `StoaProvider` treats it as a repo root
— `defaultSubagentDir = '.'` (`stoa.ts:33`) and it rebuilds both paths internally
(`:39-40`). Two providers, two meanings, one parameter. This spec does **not**
fix that; with one out-of-tree consumer any redesign is speculative. Remora's
usage becomes the third data point that decides whether it needs fixing.

---

## 9. Testing

*Only surface landing in this change is listed.*

| Area | Test |
|---|---|
| Merge | a config provider resolves by name |
| Merge | collision with a built-in throws; message contains the name and the entry index |
| Merge | duplicate names within the config array throw |
| Merge | unknown-provider error enumerates built-ins **and** config providers, built-ins first |
| **Merge — `source`** | **a fixture literally named `pangolin.config.js` (not `.mjs`) produces an error whose text contains `pangolin.config.js`.** Without this row every filename assertion is a constant compared to the constant the test typed, and a hardcoded `'pangolin.config.mjs'` passes them all |
| Laziness (D4) | `--provider claude-code` resolves with a `getSyncProviders` fake that throws if called — the idiom at `test/cmd-orch.test.ts:802-810` |
| Laziness (D4) | `--provider remora` **does** call it, and the resolved provider is the config one (positive companion — without this, the row above passes on a no-op) |
| Laziness (D4) | same pair for `capabilities sync`, which otherwise has zero rows and whose current fixtures pin laziness only incidentally (§4.5) |
| Laziness (D4) | `--help` succeeds **and** does not call a throwing `getSyncProviders` fake — guards against a later change that enumerates providers in help text and reintroduces eager loading on every invocation |
| Blast radius (§4.2) | present but import-hostile config: `--provider claude-code --dry-run` **succeeds** and prints `(dry-run) subagent <n>` |
| Blast radius (§4.2) | same config, **non**-dry-run built-in **fails** — the other half of the table in §4.2, currently untested |
| Blast radius (§4.2) | same config, a typo'd name (`--provider claude-cod`) surfaces the import error, not `unknown --provider` — pins the accepted cost |
| Validation | `undefined` export yields `[]` — **not** a validation error (D7 step 1) |
| Validation | `null` export is **rejected** (D7 step 2). Paired with the row above so the idiomatic `if (!extra) return []` cannot pass both |
| Validation | non-array export rejected, naming the config file |
| Validation | a non-object *entry* (`[null]`) yields the specified indexed error, not a raw `TypeError` |
| Validation | entry missing `loadSubagents` rejected, naming the index |
| Validation | entry with non-string `name` rejected |
| Validation | entry with missing `defaultSubagentDir` rejected |
| Absent config | no config file → seam returns `null`, and `--dry-run` sync on a built-in still succeeds |
| Fixtures (§4.5) | `test/cmd-subagent.test.ts:126` still asserts `unknown --provider 'made-up'` after being widened with `getSyncProviders` — pins that the fixture was widened rather than the member made optional |
| Wiring (§4.5) | a real bin spawn on the `test/e2e/mcp-tool-surface.test.ts` pattern — the **only** construction that executes `index.ts:110`, since `:109`'s `require.main` guard excludes vitest. Needs `--from` or a `.claude/agents` fixture: `claude-code.ts:32` does a bare `readdir(dir)` and throws ENOENT otherwise, which is why every existing sync test passes `--from` |
| Loader | `.js` and `.mjs` resolve in precedence order for each of the three `defaultGet*` functions (not §7's three *copies* — the `pangolin-mcp` copy is out of scope per D10). See EU1 for `.ts` |
| Loader | the four error-string literals from `index.ts:63,68,88,93`, asserted against values written into the test, not imported from source |
| Exports | `package.json` `exports` declares both `"."` and `"./providers"` |
| Exports | `require.resolve('@quarry-systems/pangolin-cli')` and `.../providers` both resolve against **built `dist/`** — run as a node subprocess, not in-process, so vitest's transform cannot mask a broken map |
| Exports | a real `.mjs` file **spawned by node** named-imports `ClaudeCodeProvider` from the subpath and instantiates it — pins the CJS-lexer interop of §3.1. An in-process `await import()` from vitest would never exercise `cjs-module-lexer` and would prove nothing |

Two rows carry more weight than they look. The **`source`** row is the only thing
standing between the design and a hardcoded filename that misreports in every
repo not using `.mjs`. The **fixtures** row exists because the red test in §4.5
creates active pressure toward the one repair that would silently defeat the
compiler guard.

The `exports` rows must run out-of-process. An `exports` map is exactly what a
later refactor silently narrows, and an in-process assertion observes vitest's
resolver rather than Node's.

**EU1 — open empirical question, owed before the loader row is finalized.** The
`.ts` leg of config resolution is version-dependent: Node ≥22.18 strips types by
default and resolves it, but the root `package.json` declares `"node": ">=20"`,
where the same import fails with `ERR_UNKNOWN_FILE_EXTENSION`. CI pins the
floating `node-version: '22'`, so CI passes today. This is **pre-existing behavior
of `defaultGetClient`, not introduced here.** Probe:
`node -e "import('file:///<abs>/pangolin.config.ts').then(m=>console.log(Object.keys(m)),e=>console.log(e.code))"`
on Node 20.x. Depending on the result, either drop `.ts` from the loader row and
from `config.md:18`, or add a real-bin spawn test on the
`test/e2e/mcp-tool-surface.test.ts` pattern.

**This unknown has no owning task, because no plan exists yet.** It must be given
one when the plan is written, or resolved inline before §9's Loader row is
finalized. An empirical unknown with no owner is how a known gap becomes a
shipped assumption.

---

## 10. Documentation

`docs-site/src/content/docs/how-to/sync-capabilities-subagents.md:136-171`
currently instructs the impossible for any out-of-tree reader. It becomes the
provider-authoring guide:

- write the class against `@quarry-systems/pangolin-cli/providers`
- compose with `ClaudeCodeProvider` where conventions overlap, per the existing
  composition-over-inheritance guidance (`:156-159`)
- register via `syncProviders` in `pangolin.config`
- **import safety is a requirement, not a suggestion** (see below)
- the in-tree `PROVIDERS` path stays documented for pangolin's own providers
- provisional-stability note per §8, scoped to the subpath

**The import-safety requirement is new surface this change creates, and §10 is
the only place the responsible party will read it.** A provider package imported
by `pangolin.config` is evaluated by `pangolin-mcp` at server startup
(`bin.ts:28`, `:53-58`), which has nothing to do with `sync`. The guide must
state: the package must be a real `dependency` (not a `devDependency`), must
survive a pruned production install, and must not throw at module scope. A
`config.md` line is not sufficient — that is a reference doc for the config
author, and the constraint binds the *provider* author.

The guide must also not repeat the credential-scan claim corrected in §5:
capability bundle bytes are `Uint8Array` and pass through unscanned.

Also updated:

- `docs-site/src/content/docs/reference/config.md` — add `syncProviders` beside
  the existing `default`/`client` and `orch` exports; note that two processes
  import this file (§7).
- `docs-site/src/content/docs/reference/cli.md:37,49` — the `sync` row and the
  `--provider` row currently describe the flag as selecting among built-in
  adapters. Both must say the value may also name a provider supplied by
  `syncProviders` in `pangolin.config`, and that built-in names cannot be
  overridden (D3).

No ADR. This does not change the ADR-0005 boundary (§1.4); it is an extension
point within existing posture. If the SPI is later promoted to semver-committed,
*that* is the ADR-worthy decision. The stale six-vs-nine count in ADR-0005 is a
separate pre-existing defect and is **not** fixed here.

---

## 11. Out of scope

| Excluded | Why |
|---|---|
| `loadSubagents(dir)` redesign | §8 — speculative on one consumer; the named reason the SPI is provisional |
| Global or npm-discovery provider registration | A new code-loading path needing its own trust analysis, which §1.4 specifically avoids |
| Overriding built-in providers | No consumer asking; D3 makes collision an error |
| Sharing the loader with `pangolin-mcp` | §7 — a new package-graph edge to deduplicate fifteen lines |
| Fixing ADR-0005's stale tool count | Pre-existing defect in a different artifact (§1.4); this spec cites the current source instead |
| Widening `listProviderNames` | §4.4 — zero callers; widening a dead signature is speculative |
| Provider seam on `pangolin deploy` | The manifest path is already provider-free and already expressive — `manifest-parser.ts:70` accepts either prompt field and `cmd-deploy.ts:56` passes `promptTemplate` through. Two registration paths, deliberately different: manifest for declarative, sync for convention-scanning |
| Capability bundle path seam | Already parameterized. `.claude/skills/${name}/${rel}` (`claude-code.ts:66`) is *inside* the provider; the bundle is `Record<string, Uint8Array>` and the provider owns every key. Arbitrary bundle keys are reachable today via `pangolin capabilities register --from <dir>`, so this is not a new hazard |
| Runtime adapter seam | Already exists per ADR-0003; different layer |
| Shipping `RemoraProvider` in-tree | It is the consumer's convention; the point of the SPI is that it does not need to live here |

---

## Audit record

- **2026-07-29** · rev `791d39fddb58` · lenses: absence, ambiguity, grounding,
  charter, coherence, design · **NOT READY — 2 blocking**
  - **B1** — the change moved config loading onto the dry-run path; D6 was silent
    on the third case (config present, import throws).
  - **B2** — `index.ts:110` was never wired with `getSyncProviders`, and no test
    could detect the omission.
  - Contradictions adjudicated: `design`'s clean bill on widening `CliContext` was
    overturned (it traced the compiler, not the caller); `grounding` vs `coherence`
    on `capabilities` was not a real conflict.
  - Empirical unknowns opened: **EU1** (see §9) — the `.ts` config leg on the
    declared `>=20` engines floor. Pre-existing, non-blocking, probe owed.
  - Settled during reconciliation: ESM→CJS named-import interop across the new
    subpath works; no `require`/`import` condition split needed (§3.1).
  - Downgrade log: empty — no finding was lowered.
- **2026-07-29 (post-audit revision)** — all four joint resolutions applied.
  B1 resolved by choosing **lazy** loading (D4), which dissolves the defect rather
  than documenting it. B2 resolved by §4.5 + its §9 wiring row. JR2 (§5
  `undefined`/`null`), JR3 (§3.2 barrel split + validation folded into
  `mergeProviders`), JR4 (§1.4 + §7 loader count) applied. Deferred corrections
  applied: ADR-0005 six→nine, `types.ts:6-8`→`:5-6`, 4→7 configs, `§8`→`§9`
  cross-refs, D5 wording, `listProviderNames` left alone, `splitFrontmatter`
  rationale, `cli.md` added to §10, first-`exports`-map acknowledged, §9 expanded
  from 12 rows to 19. One audit proposal **declined with reasoning**: the
  `runProviderSync` lift (§4.6).
- **2026-07-30** · rev `5827b0c9702c` · round 2, lenses: absence, ambiguity,
  grounding, charter, coherence, design · **NOT READY — 3 blocking**
  - **B1** — §4.2's broken-config blast radius is wrong in both directions, and no
    import-safety requirement is stated anywhere for third-party provider modules,
    which `pangolin-mcp` evaluates at startup (`bin.ts:28,53-58`).
  - **B2** — `source` (§4.3, §4.4, §4.6) has no producer reachable from the call
    sites; §4.2's sketch passes 2 args to a 3-param function; all three §9 rows that
    would catch it are tautological. **Introduced by round 1's JR3 fix.**
  - **B3** — the change lands `pnpm -r test` red at
    `test/cmd-subagent.test.ts:126` (`--provider made-up` is the suite's only
    built-in miss), and §4.5's detectability premise is false both ways — the
    compiler *does* catch an unwired `:110` (TS2345). The cheap repair removes that
    guard and restores round 1's B2 invisibly.
  - Downgrades logged: 2 (credential-scan claim, `validateSyncProviders` table row).
    Promotions: 3 lens DEFERREDs raised into B2/B3.
  - **Round 1 injected a false claim into this spec.** Its `absence` lens graded
    "bundles are credential-scanned" VERIFIED under *checked, no finding*; §5 then
    asserted it. It is false on this path — `capabilities-register.ts:84-88` gates
    the scan on `typeof contents === 'string'` and `CapabilityBundle.files` is
    `Record<string, Uint8Array>` (`providers/types.ts:35`). Round 1's clean bill on
    this point is **overturned**.
  - Two `.claude/audit-charter.md` entries found stale on the charter's first use;
    neither gates this spec. See that file's own header rule.
- **2026-07-30 (post-round-2 revision)** — all four joint resolutions applied.
  - **JR-A** — the seam now carries `{ providers, source } | null` (§4.5), giving
    `source` a real producer in `loadConfigModule`'s `filename` (§7); `source`
    dropped from `resolveProviderLazily` (§4.6); §4.2's sketch corrected to the
    helper form; §3.2 table made the placement authority (`listProviderNames`
    moved, shape check made module-private, `ConfigProviders` added); §5's stale
    "published `resolveProvider`" rationale and §8's "six exports" fixed.
  - **JR-B** — §4.5 rewritten: the compiler *is* the guard (TS2345 at
    `index.ts:110`) and is the *only* one; `test/cmd-subagent.test.ts:126` named as
    in-scope with an explicit prohibition on the optional-member repair; the wiring
    row replaced with a real bin spawn, since `:109`'s `require.main` guard makes
    `:110` unreachable from vitest.
  - **JR-C** — §4.2 gained the config-loading invocation table and the true blast
    radius (client construction + `pangolin-mcp` startup); §10 gained the
    import-safety requirement for provider authors; three blast-radius rows added.
  - **JR-D** — eight configs (not seven); `cmd-subagent.ts:20`/`cmd-capabilities.ts:21`;
    `defaultGetClient` no longer claimed sole config toucher; the false
    credential-scan claim struck and replaced with the corrected statement plus its
    reference-doc citation; two citation ranges widened;
    `cmd-orch.test.ts:802-810`.
  - §9 grew 19 → 27 rows. EU1 now carries an explicit "no owning task" note.
  - **Round 3 is due — this entry's `rev` is stale by construction.**
