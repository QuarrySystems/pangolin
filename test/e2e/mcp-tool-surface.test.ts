// E2E §7.7: agora-mcp run-time tool surface, verified through a real MCP
// client SDK over a real stdio transport against the real `agora-mcp` binary.
//
// This is the integration counterpart to `packages/agora-mcp/test/integration.test.ts`
// — that suite exercises `registerAgoraTools` in-process against a stubbed
// `Server` map; this one spawns `node dist/bin.js` as a child process,
// connects via `StdioClientTransport`, and drives the exact `tools/list` and
// `tools/call` request flow an external orchestrator (Claude Code, another
// MCP host) would. It is the only test that proves the bin entry, the
// agora.config.mjs resolver, the stdio bootstrap, and the tool catalog all
// wire together end-to-end through real JSON-RPC frames.
//
// Module-resolution note. `@modelcontextprotocol/sdk` is declared as a
// dependency of `@quarry-systems/agora-mcp`, not of the repo root. From a
// root-level test file vitest cannot resolve the bare specifier, so we
// import the SDK via a relative path into the agora-mcp package's hoisted
// `node_modules/` — matching the convention every other root-level E2E
// test uses for workspace packages (see `helpers/make-client.ts`).
//
// Pre-flight requirement: `pnpm -F @quarry-systems/agora-mcp build` must
// have produced `packages/agora-mcp/dist/bin.js` before this suite runs.
// The task body deliberately hard-codes `dist/bin.js` rather than honoring
// `package.json#bin` (which currently points at `dist/index.js`); a
// follow-up consolidation task will reconcile the manifest, at which point
// this hard-coded path will still work because `bin.js` is the real entry.

import { Client } from '../../packages/agora-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../packages/agora-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..');
const binPath = resolve(repoRoot, 'packages/agora-mcp/dist/bin.js');

// The fake AgoraClient body written into agora.config.mjs. Kept as a string
// rather than a TS expression so the spawned child can require/import it
// directly without a build step — agora.config.{ts,js,mjs} is resolved at
// the child's cwd by `bin.ts#defaultGetClient`. The shape is structurally
// duck-typed to the call sites in `tools.ts`: a callable `dispatch` with
// `describe` and `cancel` attached, plus three catalog namespaces each
// exposing `list` (the only method the run-time surface actually invokes).
//
// The `list()` returns deliberately include ONLY the §4.6 metadata triple
// (name, contentHash, registeredAt) so the leakage guard assertion below
// (no extra keys) is meaningful — if a future bin regression started
// reflecting full bundle contents through `list()`, the test would catch it.
const FAKE_CLIENT_SOURCE = `
const catalogEntry = (name) => ({
  name,
  contentHash: 'sha256:' + name,
  registeredAt: '2026-01-01T00:00:00.000Z',
});

const dispatchResult = {
  dispatchId: 'd-e2e-1',
  exitCode: 0,
  stdout: 'hello from e2e',
  stderr: '',
  durationMs: 7,
  resolved: {},
};

const dispatchFn = async () => dispatchResult;
dispatchFn.describe = async (id) => ({ ...dispatchResult, dispatchId: id });
dispatchFn.cancel = async () => {};

export default {
  capabilities: {
    register: async () => {},
    list: async () => [catalogEntry('cap-e2e')],
    get: async () => null,
  },
  subagent: {
    register: async () => {},
    assign: async () => {},
    list: async () => [catalogEntry('sub-e2e')],
    get: async () => null,
  },
  env: {
    register: async () => {},
    list: async () => [catalogEntry('env-e2e')],
    get: async () => null,
  },
  dispatch: dispatchFn,
};
`;

// One scratch cwd per test. The bin's config resolver looks for
// agora.config.{ts,js,mjs} relative to `process.cwd()`, so we pass this
// directory as the `cwd` of the spawned child. Cleaning up after each test
// prevents one suite's fake client from accidentally serving another's.
let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'e2e-mcp-tool-surface-'));
  await writeFile(join(configDir, 'agora.config.mjs'), FAKE_CLIENT_SOURCE);
});

afterEach(async () => {
  if (configDir) {
    await rm(configDir, { recursive: true, force: true });
    configDir = '';
  }
});

/**
 * Spawn the agora-mcp binary, connect a real MCP client, and return both
 * handles. The caller is responsible for `client.close()` (which also tears
 * down the child process via the stdio transport).
 */
async function connectClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath, // current node binary, avoids PATH ambiguity
    args: [binPath],
    cwd: configDir,
    // Inherit stderr so a child crash during start (e.g. config-resolver
    // throw, missing dep) surfaces in vitest's output rather than hanging
    // the test until the 30s timeout fires.
    stderr: 'inherit',
  });
  const client = new Client(
    { name: 'agora-mcp-e2e-test-client', version: '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

describe('E2E: agora-mcp tool surface via real MCP client', () => {
  it('listTools returns exactly the six run-time tools and zero deploy-time tools', async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'agora_capabilities_list',
        'agora_dispatch',
        'agora_dispatch_cancel',
        'agora_dispatch_describe',
        'agora_envs_list',
        'agora_subagents_list',
      ]);
      // Defense in depth: even if the sorted-equality check above is
      // refactored, the explicit deploy-time exclusion must hold.
      for (const tool of tools) {
        expect(tool.name).not.toMatch(/agora_.*_register$/);
        expect(tool.name).not.toMatch(/agora_.*_assign$/);
      }
    } finally {
      await client.close();
    }
  }, 30_000);

  it('agora_dispatch returns a DispatchResult-shaped JSON payload in text content', async () => {
    const client = await connectClient();
    try {
      const res = await client.callTool({
        name: 'agora_dispatch',
        arguments: {
          target: 'local',
          subagent: 'sub-e2e',
          workerImage: 'ghcr.io/example/worker@sha256:deadbeef',
        },
      });
      expect(res.isError).toBeFalsy();
      const content = res.content as Array<{ type: string; text: string }>;
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe('text');
      const parsed = JSON.parse(content[0].text);
      // DispatchResult shape: dispatchId, exitCode, stdout, stderr,
      // durationMs, resolved. We assert the load-bearing identifiers
      // rather than a deep-equality on the whole envelope so future
      // additions to DispatchResult don't fail this test spuriously.
      expect(parsed.dispatchId).toBe('d-e2e-1');
      expect(parsed.exitCode).toBe(0);
      expect(typeof parsed.stdout).toBe('string');
      expect(typeof parsed.stderr).toBe('string');
      expect(typeof parsed.durationMs).toBe('number');
      expect(parsed.resolved).toBeDefined();
    } finally {
      await client.close();
    }
  }, 30_000);

  it('agora_capabilities_list returns metadata only (no file-content fields)', async () => {
    const client = await connectClient();
    try {
      const res = await client.callTool({ name: 'agora_capabilities_list' });
      expect(res.isError).toBeFalsy();
      const content = res.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text) as Array<Record<string, unknown>>;
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      // §4.6 mandate: catalog list endpoints emit ONLY the metadata triple.
      // Any extra key (`files`, `body`, `systemPrompt`, secret arns, etc.)
      // would be a content-leak regression.
      const ALLOWED = ['contentHash', 'name', 'registeredAt'];
      for (const entry of parsed) {
        expect(Object.keys(entry).sort()).toEqual(ALLOWED);
      }
    } finally {
      await client.close();
    }
  }, 30_000);

  it('client closes cleanly after a call (child process exits without hanging)', async () => {
    // Regression guard: a bin that forgot to wire stdin/stdout into the
    // transport, or that left a hanging timer, would cause this test to
    // block until the per-test timeout. The explicit close() is the
    // observable signal that the JSON-RPC session terminated normally.
    const client = await connectClient();
    await client.listTools();
    await client.close();
    // If we reach this line, the transport closed without throwing. There
    // is no synchronous "did the child exit" hook exposed by the stdio
    // client transport, but `close()` resolving is the documented terminal
    // state — pid cleanup happens inside the transport.
    expect(true).toBe(true);
  }, 30_000);
});
