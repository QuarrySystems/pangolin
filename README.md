# agora

Multi-agent coordination substrate (pnpm-workspaces monorepo).

Implementation in progress; see `docs/superpowers/plans/` for the active DAG plans.

## Status

This repository is being scaffolded incrementally via a DAG-driven plan.
Packages will appear under `packages/*` as their bootstrap tasks land.

## Layout

```
package.json          # workspace root manifest
pnpm-workspace.yaml   # pnpm workspace declaration
tsconfig.base.json    # shared TS compiler options (extended by each package)
.eslintrc.cjs         # root ESLint config (typescript-eslint recommended)
.prettierrc.json      # formatting lock
packages/             # (created by subsequent tasks)
test/                 # root-level scaffold tests
```

## Common commands

```sh
pnpm install          # install workspace deps
pnpm -r run lint      # lint every package
pnpm -r run test      # test every package
pnpm -r run typecheck # typecheck every package
pnpm -r run build     # build every package
```
