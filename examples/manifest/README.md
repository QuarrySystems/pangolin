# `examples/manifest` — §4.5 worked manifest example

A minimum-viable, runnable demonstration of declarative artifact
registration via `pangolin deploy --from <manifest>`. This example pairs
with the §4.4 imperative `examples/hello-world` example: same
artifacts, declarative shape instead of TypeScript glue.

## What this example demonstrates

Five facets of the deploy manifest format covered by §4.5 of the pangolin
design:

1. **Capability registration via `from:` directory** — `git-write/`
   contains a `.claude/settings.json` permissions fragment. The deploy
   reconciler bundles every file under the directory, normalises path
   separators, content-hashes the bundle, and uploads via
   `client.capabilities.register`.
2. **Subagent registration with capability cross-references** — the
   `code-reviewer` entry binds `git-write` by name. The reconciler
   resolves the cross-ref after phase 1 has populated the registry.
3. **Env declaration with `values:` + `secrets:`** — the `prod` env
   ships a `LOG_LEVEL` literal and a `GH_TOKEN` secret.
4. **`extends:` env inheritance** — the `staging` env extends `prod`,
   overriding `LOG_LEVEL` while inheriting the rest.
5. **`from_env:` secret resolution** — `GH_TOKEN` resolves from
   `process.env.GH_TOKEN` at deploy time instead of being inlined into
   the manifest.

## DAG 2 status — what works today

The DAG 2 parser (`packages/pangolin-cli/src/manifest-parser.ts`) ships
the structural validators for `capabilities`, `subagents`, and `envs`.
It does NOT yet implement:

- `subagent.from:` dereferencing — the parser does not splice in an
  external subagent YAML body. The example works around this by
  inlining a `systemPrompt:` on the manifest entry; the
  `subagents/code-reviewer.yaml` companion file is included so the
  parser can pick it up when `from:` support lands.
- `env.extends:` inheritance — `extends:` is passed through unchanged.
  The reconciler does NOT yet inherit prod's `values:`/`secrets:` into
  staging.
- `env.secrets.<name>.from_env:` resolution — `from_env:` is passed
  through unchanged. The reconciler does NOT yet read `process.env`
  and materialise an `InlineSecret`.

The accompanying `test/deploy.test.ts` asserts the shape that DOES
work and `it.skip`s the two resolution semantics above with a TODO to
unskip when the resolver lands.

## Running the example

```bash
# From the repo root, against your local pangolin.config.ts:
pangolin deploy --from examples/manifest/pangolin-manifest.yaml
```

Expected output:

```
capability git-write	sha256:...
subagent code-reviewer	sha256:...
env prod	sha256:...
env staging	sha256:...
```

Re-running emits the same hashes — registration is idempotent against
content (§4.3).

## Files

| Path                                              | Purpose                                                      |
| ------------------------------------------------- | ------------------------------------------------------------ |
| `pangolin-manifest.yaml`                             | The §4.5 manifest itself.                                    |
| `subagents/code-reviewer.yaml`                    | External subagent definition referenced via `from:`.         |
| `caps/git-write/.claude/settings.json`            | Claude Code permissions fragment granting git + edit rights. |
| `test/deploy.test.ts`                             | Smoke test: parses cleanly + reconciler call ordering.       |
| `README.md`                                       | This file.                                                   |

## Running the smoke test

There is no `package.json` in this example directory (the task that
introduced the example is scoped to YAML + JSON + Markdown only); the
test is invoked from the repo root:

```bash
pnpm vitest run examples/manifest/test/
```

The test asserts:

- `parseManifest` accepts the example without throwing.
- The capability + subagent + env shapes match the spec.
- The deploy reconciler issues `capability → subagent → env` register
  calls in that order against a fake `Pangolin ScaleClient`.

See `../../docs/decisions/` and the `4.5` section of the design doc
for the canonical contract this example pins.
