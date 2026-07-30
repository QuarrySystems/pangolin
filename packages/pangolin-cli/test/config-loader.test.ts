// Config-resolution loader tests: the shared pangolin.config.{ts,js,mjs}
// lookup that backs defaultGetClient, defaultGetOrchContext, and
// defaultGetSyncProviders.
//
// The three error-message assertions below are typed out as literals rather
// than imported from src/index.ts on purpose — importing the strings from
// the code under test would make the pin tautological (the test would pass
// even if the message text silently drifted, as long as both copies drifted
// together).
//
// The .ts resolution leg is deliberately NOT asserted here: type-stripping
// is default-on only from Node 22.18, and this workspace's declared floor is
// `"node": ">=20"`, where importing a .ts config throws
// ERR_UNKNOWN_FILE_EXTENSION (verified: Node 20.17.0 fails, Node 22.20.0
// succeeds). CI pins Node 22, so a .ts assertion would be green in CI and
// red for any contributor on the declared floor — a failure CI structurally
// cannot see.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultGetClient, defaultGetOrchContext, defaultGetSyncProviders } from '../src/index.js';

const NO_CONFIG_FOUND = (cwd: string): string =>
  `pangolin-cli: no pangolin.config.{ts,js,mjs} found in ${cwd}`;
const CLIENT_MISSING = (filename: string): string =>
  `pangolin-cli: ${filename} must export an PangolinClient instance as default or named 'client'`;
const ORCH_MISSING = (filename: string): string =>
  `pangolin-cli: ${filename} must export an OrchContext as a named 'orch' export for pangolin orch commands`;

let dir: string;
let originalCwd: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'config-loader-'));
  originalCwd = process.cwd();
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(dir, { recursive: true, force: true });
});

describe('defaultGetSyncProviders', () => {
  it('returns null when no pangolin.config.* exists in cwd', async () => {
    await expect(defaultGetSyncProviders()).resolves.toBeNull();
  });

  it('returns { providers: [], source } when the config has no syncProviders export', async () => {
    await writeFile(join(dir, 'pangolin.config.mjs'), 'export default {};\n');
    await expect(defaultGetSyncProviders()).resolves.toEqual({
      providers: [],
      source: 'pangolin.config.mjs',
    });
  });

  it('normalizes an explicit `undefined` syncProviders export to []', async () => {
    await writeFile(
      join(dir, 'pangolin.config.mjs'),
      'export const syncProviders = undefined;\nexport default {};\n',
    );
    await expect(defaultGetSyncProviders()).resolves.toEqual({
      providers: [],
      source: 'pangolin.config.mjs',
    });
  });

  it('reports the .js filename when that is the leg that resolved', async () => {
    await writeFile(join(dir, 'pangolin.config.js'), 'exports.syncProviders = [];\n');
    const got = await defaultGetSyncProviders();
    expect(got).toEqual({ providers: [], source: 'pangolin.config.js' });
  });

  it('resolves .js before .mjs when both are present', async () => {
    await writeFile(join(dir, 'pangolin.config.js'), 'exports.syncProviders = [];\n');
    await writeFile(join(dir, 'pangolin.config.mjs'), 'export const syncProviders = [];\n');
    await expect(defaultGetSyncProviders()).resolves.toEqual({
      providers: [],
      source: 'pangolin.config.js',
    });
  });

  it("passes a non-array syncProviders export through unnormalized (not the loader's job to reject)", async () => {
    await writeFile(
      join(dir, 'pangolin.config.mjs'),
      'export const syncProviders = null;\nexport default {};\n',
    );
    await expect(defaultGetSyncProviders()).resolves.toEqual({
      providers: null,
      source: 'pangolin.config.mjs',
    });
  });
});

describe('defaultGetClient error messages', () => {
  it('throws the no-config-found message when cwd has no pangolin.config.*', async () => {
    await expect(defaultGetClient()).rejects.toThrow(NO_CONFIG_FOUND(process.cwd()));
  });

  it('throws the missing-client message when the config exports neither default nor client', async () => {
    await writeFile(join(dir, 'pangolin.config.mjs'), 'export const orch = {};\n');
    await expect(defaultGetClient()).rejects.toThrow(CLIENT_MISSING('pangolin.config.mjs'));
  });
});

describe('defaultGetOrchContext error messages', () => {
  it('throws the SAME no-config-found message as defaultGetClient (byte-identical, not a fourth string)', async () => {
    await expect(defaultGetOrchContext()).rejects.toThrow(NO_CONFIG_FOUND(process.cwd()));
  });

  it('throws the missing-orch message when the config has no named orch export', async () => {
    await writeFile(join(dir, 'pangolin.config.mjs'), 'export default {};\n');
    await expect(defaultGetOrchContext()).rejects.toThrow(ORCH_MISSING('pangolin.config.mjs'));
  });
});
