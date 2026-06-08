// `examples/manifest/test/deploy.test.ts`
//
// Smoke test for the §4.5 worked manifest example.
//
// Pins three facets:
//
//   1. The manifest at `examples/manifest/pangolin-manifest.yaml` parses
//      cleanly through `parseManifest` — i.e. the example actually
//      satisfies the same validation gate `pangolin deploy --from <path>`
//      runs at deploy time.
//   2. The capability and subagent declarations carry the expected shape
//      (`name`, `from`, `capabilities` cross-reference).
//   3. The deploy reconciler issues capability → subagent → env register
//      calls in that order against a fake client when given this manifest.
//
// REFINEMENT (DAG 2 import-shape note):
//   The natural import target for `parseManifest` is the published barrel:
//
//     import { parseManifest } from '@quarry-systems/pangolin-cli';
//
//   `parseManifest` is, however, NOT re-exported from the `pangolin-cli`
//   barrel as of DAG 2 — only `buildProgram` + `defaultGetClient` ship from
//   `src/index.ts`. The next-most-natural shape is a deep-import into the
//   compiled `dist/`:
//
//     import { parseManifest } from '@quarry-systems/pangolin-cli/dist/manifest-parser.js';
//
//   That path resolves correctly when the workspace package is symlinked
//   into a consumer's `node_modules`, but at the repo root the pangolin
//   workspace packages are NOT symlinked (the root `package.json` lists no
//   workspace deps), so the deep import fails to resolve from this file.
//
//   The pragmatic in-tree alternative — and the one used by the sibling
//   e2e suites under `test/e2e/` — is a relative source-tree import:
//
//     import { parseManifest } from '../../../packages/pangolin-cli/src/manifest-parser.js';
//
//   Vitest transpiles the `.ts` file resolved by the `.js`-suffixed
//   NodeNext specifier, so we don't need a build step. We use that here.
//
//   TODO: when `pangolin-cli` re-exports `parseManifest` (and `attachDeployCmd`)
//   from its barrel, switch this import to:
//       `import { parseManifest } from '@quarry-systems/pangolin-cli';`
//   and drop the relative deep-reach.
import { parseManifest } from '../../../packages/pangolin-cli/src/manifest-parser.js';
import { buildProgram } from '../../../packages/pangolin-cli/src/index.js';
import { attachDeployCmd } from '../../../packages/pangolin-cli/src/cmd-deploy.js';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const exampleRoot = resolve(__dirname, '..');
const manifestPath = resolve(exampleRoot, 'pangolin-manifest.yaml');

describe('§4.5 manifest example', () => {
  it('parses cleanly via parseManifest', async () => {
    const m = await parseManifest(manifestPath);
    expect(m.capabilities?.[0].name).toBe('git-write');
    expect(m.subagents?.[0].name).toBe('code-reviewer');
    expect(m.subagents?.[0].capabilities).toEqual(['git-write']);
    expect(m.envs?.[0].name).toBe('prod');
    expect(m.envs?.[1].name).toBe('staging');
  });

  it('declares prod env with values + secrets and staging env extending prod', async () => {
    const m = await parseManifest(manifestPath);

    const prod = m.envs?.find((e) => e.name === 'prod');
    expect(prod?.values?.LOG_LEVEL).toBe('info');
    // Secrets are passed through unchanged by parseManifest; the example
    // uses `from_env:` shape which the deploy-time secret resolver in a
    // future task will translate into an `InlineSecret`. Until then the
    // parser exposes the literal YAML.
    expect(prod?.secrets?.GH_TOKEN).toBeDefined();

    // `extends:` is not yet a first-class parser field (see DAG 2 notes
    // in `cmd-deploy.ts`); the parser passes it through as an extra
    // property. We pin the shape so when extends support lands the
    // assertion sharpens to a proper inheritance check.
    const staging = m.envs?.find((e) => e.name === 'staging') as
      | (typeof m.envs extends Array<infer T> ? T : never)
      | undefined;
    expect(staging).toBeDefined();
    expect((staging as unknown as { extends?: string }).extends).toBe('prod');
    expect(staging?.values?.LOG_LEVEL).toBe('debug');
  });

  // `extends:` env inheritance and `from_env:` secret resolution are not
  // yet implemented in the manifest parser/reconciler (see DAG 2). When
  // they land, drop these skips and assert the resolved shapes.
  it.skip('resolves `extends:` so staging inherits prod values', async () => {
    const m = await parseManifest(manifestPath);
    const staging = m.envs?.find((e) => e.name === 'staging');
    // After extends resolution lands: staging should inherit any prod
    // values that it does not override.
    expect(staging?.values).toBeDefined();
  });

  it.skip('resolves `from_env:` against process.env at deploy time', async () => {
    process.env.GH_TOKEN = 'sentinel-token';
    const m = await parseManifest(manifestPath);
    const prod = m.envs?.find((e) => e.name === 'prod');
    // After from_env resolution lands: GH_TOKEN should be materialised
    // into an InlineSecret whose value equals process.env.GH_TOKEN.
    expect((prod?.secrets?.GH_TOKEN as { inline?: string }).inline).toBe(
      'sentinel-token',
    );
  });

  it('deploy reconciler issues register calls in capability → subagent → env order', async () => {
    const calls: string[] = [];

    const mockClient = {
      capabilities: {
        register: vi.fn(async (opts: { name: string }) => {
          calls.push(`cap:${opts.name}`);
          return { name: opts.name, contentHash: 'sha256:cap', registeredAt: 't0' };
        }),
      },
      subagent: {
        register: vi.fn(async (opts: { name: string }) => {
          calls.push(`sub:${opts.name}`);
          return { name: opts.name, contentHash: 'sha256:sub', registeredAt: 't1' };
        }),
      },
      env: {
        register: vi.fn(async (opts: { name: string }) => {
          calls.push(`env:${opts.name}`);
          return { name: opts.name, contentHash: 'sha256:env', registeredAt: 't2' };
        }),
      },
    };

    // Run from the example directory so the relative `from:` paths in the
    // manifest resolve correctly (mirrors how a user would invoke
    // `pangolin deploy --from examples/manifest/pangolin-manifest.yaml` from a
    // project root containing the example).
    const originalCwd = process.cwd();
    process.chdir(exampleRoot);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const program = buildProgram({ getClient: async () => mockClient as never });
      attachDeployCmd(program, { getClient: async () => mockClient as never });
      await program.parseAsync(['node', 'pangolin', 'deploy', '--from', manifestPath]);
    } finally {
      logSpy.mockRestore();
      process.chdir(originalCwd);
    }

    expect(calls).toEqual([
      'cap:git-write',
      'sub:code-reviewer',
      'env:prod',
      'env:staging',
    ]);
  });
});
