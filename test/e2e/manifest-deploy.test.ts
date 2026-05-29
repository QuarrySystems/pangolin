// E2E: `agora deploy --from <manifest>` reconciler end-to-end.
//
// Drives the deploy subcommand via the full commander program + the
// `attachDeployCmd` from `packages/agora-cli/src/cmd-deploy.ts` against a
// content-aware fake `AgoraClient`. Pins three load-bearing properties:
//
//   1. Registration call ORDER: the reconciler walks the manifest in
//      capabilities → subagents → envs phases (asserted via vi's monotonic
//      `mock.invocationCallOrder` rather than fragile push-into-array).
//
//   2. Idempotency: re-running the same manifest against the same content
//      yields identical contentHashes per entity. The fake client's
//      `register` derives its returned `contentHash` from the input bytes
//      (capabilities) / values + secrets (envs) / inline systemPrompt + caps
//      list (subagents), so "same input, same hash" is enforced by the fake
//      itself rather than by reading back the hash literal.
//
//   3. Change-on-edit: mutating capability bundle content or env values
//      produces a NEW contentHash on the next deploy. This is the
//      content-addressed-versioning property §4.3 elevates to e2e through
//      the deploy reconciler (not just direct client calls).
//
// `extends:` env inheritance and `from_env:` secret resolution: the current
// `parseManifest` (packages/agora-cli/src/manifest-parser.ts) does NOT
// support these fields. The acceptance criterion for this task allows
// documenting the limitation and skipping — covered by the `it.skip` block
// at the bottom of this file. When the parser learns those fields, drop the
// skip and assert the inheritance/resolution semantics here.
//
// No Docker, no real storage, no compute providers — this is a CLI-shape
// e2e against a fake client. The sibling
// `test/e2e/content-hash-versioning.test.ts` covers the same versioning
// invariants against the REAL client + LocalStorageProvider; this file
// covers them through the manifest reconciler shell instead.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Relative imports into agora-cli/src — root vitest has no workspace-package
// symlinks at <repo>/node_modules, so we go directly to the source-tree
// barrels (same convention as the sibling e2e tests).
import { buildProgram } from '../../packages/agora-cli/src/index.js';

// ---------------------------------------------------------------------------
// Content-aware fake AgoraClient
// ---------------------------------------------------------------------------
//
// Unlike the `vi.fn(() => 'sha256:cap')` fakes in the in-package unit tests,
// this fake derives each returned `contentHash` from the input bytes. Two
// register calls with the same input therefore return the same hash, and
// any input mutation yields a different hash — exactly what the
// content-addressed-versioning §4.3 contract specifies.

function hashOf(obj: unknown): string {
  // Stable JSON for plain objects; for Uint8Array values inside capability
  // bundles, JSON.stringify would emit `{}`, so we serialize the file map
  // as a sorted list of [path, byteString] pairs before hashing. The exact
  // canonicalization choice is internal to the fake — production uses
  // canonical-json + sha256, but for THIS test all we need is "same input,
  // same hash; different input, different hash."
  const normalized = JSON.stringify(obj, (_k, v) => {
    if (v instanceof Uint8Array) {
      // Convert to a stable string form so the hash is deterministic.
      return Array.from(v);
    }
    return v;
  });
  return 'sha256:' + createHash('sha256').update(normalized).digest('hex');
}

function makeFakeClient() {
  const capRegister = vi.fn(
    async (opts: { name: string; files: Record<string, Uint8Array> }) => {
      // Sort file paths so {a,b} and {b,a} hash identically.
      const sortedFiles: Record<string, Uint8Array> = {};
      for (const k of Object.keys(opts.files).sort()) {
        sortedFiles[k] = opts.files[k]!;
      }
      const contentHash = hashOf({ name: opts.name, files: sortedFiles });
      return { name: opts.name, contentHash, registeredAt: '2026-05-22' };
    },
  );

  const subRegister = vi.fn(
    async (opts: {
      name: string;
      systemPrompt?: string;
      promptTemplate?: string;
      model?: string;
      capabilities?: string[];
    }) => {
      const contentHash = hashOf({
        name: opts.name,
        systemPrompt: opts.systemPrompt,
        promptTemplate: opts.promptTemplate,
        model: opts.model,
        // Sort capability refs so order doesn't affect hash.
        capabilities: [...(opts.capabilities ?? [])].sort(),
      });
      return {
        name: opts.name,
        contentHash,
        registeredAt: '2026-05-22',
        assign: vi.fn(async () => ({})),
      };
    },
  );

  const envRegister = vi.fn(
    async (opts: {
      name: string;
      values?: Record<string, string>;
      secrets?: Record<string, unknown>;
    }) => {
      const contentHash = hashOf({
        name: opts.name,
        values: opts.values ?? {},
        secrets: opts.secrets ?? {},
      });
      return { name: opts.name, contentHash, registeredAt: '2026-05-22' };
    },
  );

  const dispatchFn = Object.assign(vi.fn(), {
    describe: vi.fn(),
    cancel: vi.fn(),
  });

  return {
    capabilities: {
      register: capRegister,
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
    },
    subagent: {
      register: subRegister,
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
    },
    env: {
      register: envRegister,
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
    },
    dispatch: dispatchFn,
  };
}

type FakeClient = ReturnType<typeof makeFakeClient>;

// ---------------------------------------------------------------------------
// Manifest fixture helpers
// ---------------------------------------------------------------------------
//
// All YAML is emitted in block style — flow style would misparse on Windows
// because the temp directory path contains a `:` (e.g. `C:/Users/...`).
// `from:` paths are written with forward slashes for the same reason.

function manifestYaml(opts: {
  capFromAbs: string;
  capName: string;
  subName: string;
  envName: string;
  envValue: string;
}): string {
  const capFromForYaml = opts.capFromAbs.replace(/\\/g, '/');
  return [
    'capabilities:',
    `  - name: ${opts.capName}`,
    `    from: "${capFromForYaml}"`,
    'subagents:',
    `  - name: ${opts.subName}`,
    '    systemPrompt: do the thing',
    `    capabilities: [${opts.capName}]`,
    'envs:',
    `  - name: ${opts.envName}`,
    '    values:',
    `      LOG_LEVEL: ${opts.envValue}`,
    '',
  ].join('\n');
}

async function runDeploy(fake: FakeClient, manifestPath: string): Promise<void> {
  const ctx = { getClient: async () => fake as any };
  // buildProgram already wires the deploy command; no separate attach needed.
  const program = buildProgram(ctx);
  await program.parseAsync(['node', 'agora', 'deploy', '--from', manifestPath]);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

let manifestDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  manifestDir = await mkdtemp(join(tmpdir(), 'e2e-manifest-'));
  // The deploy reconciler emits one `<type> <name>\t<hash>` line per entry;
  // silence those to keep the test output clean.
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await rm(manifestDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('E2E: agora deploy reconciler', () => {
  it('registers capabilities then subagents then envs in manifest order', async () => {
    const capDir = join(manifestDir, 'caps', 'git-write');
    await mkdir(capDir, { recursive: true });
    await writeFile(join(capDir, 'tool.json'), '{}');

    const manifestPath = join(manifestDir, 'agora-manifest.yaml');
    await writeFile(
      manifestPath,
      manifestYaml({
        capFromAbs: capDir,
        capName: 'git-write',
        subName: 'code-reviewer',
        envName: 'prod',
        envValue: 'info',
      }),
    );

    const fake = makeFakeClient();
    await runDeploy(fake, manifestPath);

    // Each phase fires exactly once.
    expect(fake.capabilities.register).toHaveBeenCalledTimes(1);
    expect(fake.subagent.register).toHaveBeenCalledTimes(1);
    expect(fake.env.register).toHaveBeenCalledTimes(1);

    // Strict phase ordering via vi's monotonic invocationCallOrder.
    const capOrder = fake.capabilities.register.mock.invocationCallOrder[0]!;
    const subOrder = fake.subagent.register.mock.invocationCallOrder[0]!;
    const envOrder = fake.env.register.mock.invocationCallOrder[0]!;
    expect(capOrder).toBeLessThan(subOrder);
    expect(subOrder).toBeLessThan(envOrder);

    // The subagent references the capability by name (manifest wiring).
    const subCall = fake.subagent.register.mock.calls[0]![0] as {
      capabilities?: string[];
    };
    expect(subCall.capabilities).toEqual(['git-write']);
  });

  it('idempotent re-run produces identical content hashes per entity', async () => {
    const capDir = join(manifestDir, 'caps', 'git-write');
    await mkdir(capDir, { recursive: true });
    await writeFile(join(capDir, 'tool.json'), '{"version":1}');

    const manifestPath = join(manifestDir, 'agora-manifest.yaml');
    await writeFile(
      manifestPath,
      manifestYaml({
        capFromAbs: capDir,
        capName: 'git-write',
        subName: 'code-reviewer',
        envName: 'prod',
        envValue: 'info',
      }),
    );

    const fake = makeFakeClient();

    // First deploy.
    await runDeploy(fake, manifestPath);
    const capHash1 = (await fake.capabilities.register.mock.results[0]!.value).contentHash;
    const subHash1 = (await fake.subagent.register.mock.results[0]!.value).contentHash;
    const envHash1 = (await fake.env.register.mock.results[0]!.value).contentHash;

    // Second deploy of the EXACT same manifest + capability bytes.
    await runDeploy(fake, manifestPath);
    const capHash2 = (await fake.capabilities.register.mock.results[1]!.value).contentHash;
    const subHash2 = (await fake.subagent.register.mock.results[1]!.value).contentHash;
    const envHash2 = (await fake.env.register.mock.results[1]!.value).contentHash;

    // Each phase fired twice (the reconciler doesn't itself cache — the
    // SDK's content-addressed register path is what deduplicates on the
    // server side). The hashes must match across runs.
    expect(fake.capabilities.register).toHaveBeenCalledTimes(2);
    expect(fake.subagent.register).toHaveBeenCalledTimes(2);
    expect(fake.env.register).toHaveBeenCalledTimes(2);

    expect(capHash2).toBe(capHash1);
    expect(subHash2).toBe(subHash1);
    expect(envHash2).toBe(envHash1);
  });

  it('changed capability bundle content produces a new contentHash on next deploy', async () => {
    const capDir = join(manifestDir, 'caps', 'git-write');
    await mkdir(capDir, { recursive: true });
    await writeFile(join(capDir, 'tool.json'), '{"version":1}');

    const manifestPath = join(manifestDir, 'agora-manifest.yaml');
    await writeFile(
      manifestPath,
      manifestYaml({
        capFromAbs: capDir,
        capName: 'git-write',
        subName: 'code-reviewer',
        envName: 'prod',
        envValue: 'info',
      }),
    );

    const fake = makeFakeClient();

    await runDeploy(fake, manifestPath);
    const capHashBefore = (await fake.capabilities.register.mock.results[0]!.value).contentHash;

    // Mutate the capability bundle content (same logical name + path).
    await writeFile(join(capDir, 'tool.json'), '{"version":2}');

    await runDeploy(fake, manifestPath);
    const capHashAfter = (await fake.capabilities.register.mock.results[1]!.value).contentHash;

    expect(capHashAfter).not.toBe(capHashBefore);

    // Sanity: the env (which did NOT change) keeps its hash, isolating the
    // change to the mutated entity.
    const envHashBefore = (await fake.env.register.mock.results[0]!.value).contentHash;
    const envHashAfter = (await fake.env.register.mock.results[1]!.value).contentHash;
    expect(envHashAfter).toBe(envHashBefore);
  });

  it('changed env values produce a new contentHash on next deploy', async () => {
    const capDir = join(manifestDir, 'caps', 'git-write');
    await mkdir(capDir, { recursive: true });
    await writeFile(join(capDir, 'tool.json'), '{}');

    const manifestPath = join(manifestDir, 'agora-manifest.yaml');
    await writeFile(
      manifestPath,
      manifestYaml({
        capFromAbs: capDir,
        capName: 'git-write',
        subName: 'code-reviewer',
        envName: 'prod',
        envValue: 'info',
      }),
    );

    const fake = makeFakeClient();
    await runDeploy(fake, manifestPath);
    const envHashBefore = (await fake.env.register.mock.results[0]!.value).contentHash;

    // Rewrite the manifest with a different env value (LOG_LEVEL: debug).
    await writeFile(
      manifestPath,
      manifestYaml({
        capFromAbs: capDir,
        capName: 'git-write',
        subName: 'code-reviewer',
        envName: 'prod',
        envValue: 'debug',
      }),
    );

    await runDeploy(fake, manifestPath);
    const envHashAfter = (await fake.env.register.mock.results[1]!.value).contentHash;

    expect(envHashAfter).not.toBe(envHashBefore);

    // The capability bundle did not change, so its hash is stable.
    const capHashBefore = (await fake.capabilities.register.mock.results[0]!.value).contentHash;
    const capHashAfter = (await fake.capabilities.register.mock.results[1]!.value).contentHash;
    expect(capHashAfter).toBe(capHashBefore);
  });

  // `extends:` env inheritance and `from_env:` secret resolution are not
  // (yet) supported by `parseManifest` — see
  // `packages/agora-cli/src/manifest-parser.ts`. The parser allows but does
  // not interpret these fields; the deploy reconciler forwards `values` /
  // `secrets` to `env.register` verbatim. When the parser grows these
  // semantics, drop `.skip` and assert:
  //   - extends: <base> merges base.values with child.values (child wins),
  //   - from_env: <NAME> resolves at deploy time from process.env into a
  //     concrete value (or a SecretRef stub) before the register call.
  it.skip(
    'parser does not yet support `extends:` env inheritance or `from_env:` secret resolution (current parser limitation — see manifest-parser.ts)',
    () => {
      // intentionally empty; documented limitation.
    },
  );
});

// Silence unused-binding lint on logSpy — it exists for its side effect.
void logSpy;
