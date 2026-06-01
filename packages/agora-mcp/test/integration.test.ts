// End-to-end wiring tests for `registerAgoraTools`.
//
// These exercise the MCP `Server`'s in-process request-handler map directly:
// we never spin up a stdio transport (that's `task-e2e-mcp-tool-surface`'s job
// against the real MCP client SDK). Here we verify that:
//   1. ListTools advertises exactly the nine tool names exported as the
//      `AGORA_TOOL_NAMES` allowlist;
//   2. No `agora_*_register` / `agora_*_assign` deploy-time tools leak;
//   3. Each CallTool name dispatches to the matching `AgoraClient` method
//      with the supplied arguments, and the result is wrapped in the MCP
//      `{ content: [{ type: 'text', text: <JSON> }] }` envelope;
//   4. The three catalog tools return metadata-only objects (only
//      `name`, `contentHash`, `registeredAt`) — never file contents, secret
//      values, or prompt bodies;
//   5. An unknown tool name produces the MCP-SDK `{ content, isError: true }`
//      error response rather than throwing;
//   6. The three orchestrator tools (submit/status/watch) call through to
//      OperationsApi when provided, or return a clear not-configured isError
//      when absent.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, it, expect, vi } from 'vitest';
import { AGORA_TOOL_NAMES, registerAgoraTools } from '../src/tools.js';
import type { OperationsApi, OutboxRecord } from '@quarry-systems/agora-orchestrator';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build an in-memory fake `AgoraClient`. Each method is a `vi.fn()` so tests
 * can assert call args. The `dispatch` property is a callable function with
 * `describe` and `cancel` attached, matching the prototype-installed shape
 * of the real client.
 */
function makeFakeClient() {
  const catalogEntry = (name: string) => ({
    name,
    contentHash: `sha256:${name}`,
    registeredAt: '2026-01-01T00:00:00.000Z',
  });

  const dispatchResult = {
    dispatchId: 'd1',
    exitCode: 0,
    stdout: 'hello',
    stderr: '',
    durationMs: 42,
    resolved: {} as Record<string, unknown>,
  };

  const dispatchFn = vi.fn(async () => dispatchResult);
  const describeFn = vi.fn(async (id: string) => ({ ...dispatchResult, dispatchId: id }));
  const cancelFn = vi.fn(async (_id: string) => {});

  const dispatch = Object.assign(dispatchFn, {
    describe: describeFn,
    cancel: cancelFn,
  });

  return {
    capabilities: {
      register: vi.fn(),
      list: vi.fn(async () => [catalogEntry('cap-a')]),
      get: vi.fn(),
    },
    subagent: {
      register: vi.fn(),
      assign: vi.fn(),
      list: vi.fn(async () => [catalogEntry('sub-a')]),
      get: vi.fn(),
    },
    env: {
      register: vi.fn(),
      list: vi.fn(async () => [catalogEntry('env-a')]),
      get: vi.fn(),
    },
    dispatch,
  };
}

/**
 * Build a fake OperationsApi with vi.fn() methods for submit, status, watch.
 */
function makeFakeOrch(overrides?: Partial<OperationsApi>): OperationsApi {
  const statusRecord: OutboxRecord = {
    runId: 'run-1',
    kind: 'status',
    body: { status: 'done' },
    at: '2026-01-01T00:00:00.000Z',
  };

  const submitFn = vi.fn(async (_run: unknown, _actor: string) => 'run-1');
  const statusFn = vi.fn(async (_runId: string) => statusRecord);
  // watch returns an async generator that yields one record then stops
  const watchFn = vi.fn(async function* (_runId: string, _opts?: unknown) {
    yield statusRecord;
  });
  const cancelFn = vi.fn(async (_target: string, _actor: string) => {});
  const auditFn = vi.fn(async (_runId: string) => ({}));

  return {
    submit: submitFn,
    status: statusFn,
    watch: watchFn,
    cancel: cancelFn,
    audit: auditFn,
    ...overrides,
  } as unknown as OperationsApi;
}

/** Build a server with the six tools registered (no orch). */
function makeServerWith(fake: ReturnType<typeof makeFakeClient>): Server {
  const server = new Server(
    { name: 'test', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  // The fake client's structural shape matches AgoraClient at the call sites
  // exercised here; the cast is necessary because vi.fn() return types do
  // not carry the full agora-core type tree.
  registerAgoraTools(server, fake as never);
  return server;
}

/** Build a server with all nine tools registered (with orch). */
function makeServerWithOrch(fake: ReturnType<typeof makeFakeClient>, fakeOrch: OperationsApi): Server {
  const server = new Server(
    { name: 'test', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  registerAgoraTools(server, fake as never, fakeOrch);
  return server;
}

/** Look up an internal request handler by method literal. */
function getHandler(server: Server, method: string): (req: unknown) => Promise<unknown> {
  // `_requestHandlers` is a private Map<string, handler> on the Protocol
  // base class. Accessing it directly is the documented in-process test
  // pattern when stdio isn't desired.
  const map = (server as unknown as { _requestHandlers: Map<string, (req: unknown) => Promise<unknown>> })
    ._requestHandlers;
  const handler = map.get(method);
  if (!handler) {
    throw new Error(`no handler registered for method: ${method}`);
  }
  return handler;
}

/** Invoke ListTools and return its tools array. */
async function listTools(server: Server): Promise<Array<{ name: string }>> {
  const handler = getHandler(server, 'tools/list');
  const result = (await handler({ method: 'tools/list', params: {} })) as {
    tools: Array<{ name: string }>;
  };
  return result.tools;
}

/** Invoke CallTool with the given name + args. */
async function callTool(
  server: Server,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const handler = getHandler(server, 'tools/call');
  return (await handler({
    method: 'tools/call',
    params: { name, arguments: args },
  })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agora-mcp registerAgoraTools — ListTools', () => {
  it('registers exactly nine tools matching AGORA_TOOL_NAMES', async () => {
    const server = makeServerWith(makeFakeClient());
    const tools = await listTools(server);
    expect(tools.map((t) => t.name).sort()).toEqual([...AGORA_TOOL_NAMES].sort());
    expect(tools).toHaveLength(9);
  });

  it('exposes no tool matching agora_*_register or agora_*_assign', async () => {
    const server = makeServerWith(makeFakeClient());
    const tools = await listTools(server);
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/agora_.*_register$/);
      expect(tool.name).not.toMatch(/agora_.*_assign$/);
    }
  });

  it('every advertised tool has a description and an object inputSchema', async () => {
    const server = makeServerWith(makeFakeClient());
    const tools = (await listTools(server)) as Array<{
      name: string;
      description?: string;
      inputSchema?: { type?: string };
    }>;
    for (const tool of tools) {
      expect(tool.description, `${tool.name} missing description`).toBeTruthy();
      expect(tool.inputSchema?.type, `${tool.name} inputSchema not object`).toBe('object');
    }
  });
});

describe('agora-mcp registerAgoraTools — CallTool dispatch', () => {
  it('agora_dispatch invokes client.dispatch with the supplied args and wraps the result', async () => {
    const fake = makeFakeClient();
    const server = makeServerWith(fake);
    const args = {
      target: 'tgt',
      subagent: 'sub-a',
      workerImage: 'image:digest',
      input: { foo: 'bar' },
    };
    const res = await callTool(server, 'agora_dispatch', args);

    expect(fake.dispatch).toHaveBeenCalledTimes(1);
    expect(fake.dispatch).toHaveBeenCalledWith(args);
    expect(res.isError).toBeFalsy();
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.dispatchId).toBe('d1');
    expect(parsed.exitCode).toBe(0);
  });

  it('agora_dispatch_describe invokes client.dispatch.describe(dispatchId)', async () => {
    const fake = makeFakeClient();
    const server = makeServerWith(fake);
    const res = await callTool(server, 'agora_dispatch_describe', { dispatchId: 'abc' });

    expect(fake.dispatch.describe).toHaveBeenCalledTimes(1);
    expect(fake.dispatch.describe).toHaveBeenCalledWith('abc');
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.dispatchId).toBe('abc');
  });

  it('agora_dispatch_cancel invokes client.dispatch.cancel(dispatchId)', async () => {
    const fake = makeFakeClient();
    const server = makeServerWith(fake);
    const res = await callTool(server, 'agora_dispatch_cancel', { dispatchId: 'xyz' });

    expect(fake.dispatch.cancel).toHaveBeenCalledTimes(1);
    expect(fake.dispatch.cancel).toHaveBeenCalledWith('xyz');
    expect(res.isError).toBeFalsy();
    expect(res.content[0].type).toBe('text');
    // The cancel tool returns a confirmation string, not JSON.
    expect(res.content[0].text).toContain('xyz');
  });

  it('agora_capabilities_list invokes client.capabilities.list()', async () => {
    const fake = makeFakeClient();
    const server = makeServerWith(fake);
    const res = await callTool(server, 'agora_capabilities_list');

    expect(fake.capabilities.list).toHaveBeenCalledTimes(1);
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].name).toBe('cap-a');
  });

  it('agora_subagents_list invokes client.subagent.list()', async () => {
    const fake = makeFakeClient();
    const server = makeServerWith(fake);
    const res = await callTool(server, 'agora_subagents_list');

    expect(fake.subagent.list).toHaveBeenCalledTimes(1);
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].name).toBe('sub-a');
  });

  it('agora_envs_list invokes client.env.list()', async () => {
    const fake = makeFakeClient();
    const server = makeServerWith(fake);
    const res = await callTool(server, 'agora_envs_list');

    expect(fake.env.list).toHaveBeenCalledTimes(1);
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].name).toBe('env-a');
  });
});

describe('agora-mcp registerAgoraTools — catalog leakage guard', () => {
  // The catalog tools are the metadata surface: §4.6 mandates they return
  // ONLY { name, contentHash, registeredAt } — never file contents, secret
  // values, or system-prompt bodies. We assert by parsing the JSON response
  // and rejecting any extra keys.
  const ALLOWED_KEYS = ['name', 'contentHash', 'registeredAt'];

  it.each([
    ['agora_capabilities_list'],
    ['agora_subagents_list'],
    ['agora_envs_list'],
  ])('%s response entries contain only name/contentHash/registeredAt', async (toolName) => {
    const fake = makeFakeClient();
    const server = makeServerWith(fake);
    const res = await callTool(server, toolName);
    const parsed = JSON.parse(res.content[0].text) as Array<Record<string, unknown>>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    for (const entry of parsed) {
      const keys = Object.keys(entry).sort();
      expect(keys, `${toolName} entry has unexpected keys: ${keys.join(',')}`).toEqual(
        [...ALLOWED_KEYS].sort(),
      );
    }
  });
});

describe('agora-mcp registerAgoraTools — error path', () => {
  it('unknown tool name returns isError: true rather than throwing', async () => {
    const fake = makeFakeClient();
    const server = makeServerWith(fake);
    // Must NOT throw.
    const res = await callTool(server, 'agora_nonexistent_tool');
    expect(res.isError).toBe(true);
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    expect(res.content[0].text).toMatch(/nonexistent/);
  });

  it('client method that throws becomes an isError response (no stack leak)', async () => {
    const fake = makeFakeClient();
    // Replace dispatch with a fn that throws an Error with a stack.
    const boom = new Error('boom from client');
    boom.stack = 'Error: boom from client\n    at /internal/path/that/should/not/leak.ts:42:7';
    const failing = Object.assign(
      vi.fn(async () => {
        throw boom;
      }),
      {
        describe: vi.fn(async () => ({})),
        cancel: vi.fn(async () => {}),
      },
    );
    (fake as { dispatch: unknown }).dispatch = failing;

    const server = makeServerWith(fake);
    const res = await callTool(server, 'agora_dispatch', {
      target: 't',
      subagent: 's',
      workerImage: 'i',
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('boom from client');
    // Stack frames (file paths) must not be reflected to the orchestrator.
    expect(res.content[0].text).not.toContain('/internal/path/that/should/not/leak.ts');
  });

  it('agora_dispatch_describe with missing dispatchId returns isError, does not throw', async () => {
    const fake = makeFakeClient();
    const server = makeServerWith(fake);
    const res = await callTool(server, 'agora_dispatch_describe', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/dispatchId/);
    expect(fake.dispatch.describe).not.toHaveBeenCalled();
  });
});

describe('agora-mcp registerAgoraTools — orchestrator tools (not configured)', () => {
  it('agora_orchestrator_submit returns isError when orch not provided', async () => {
    const fake = makeFakeClient();
    const server = makeServerWith(fake);
    const res = await callTool(server, 'agora_orchestrator_submit', { plan: { id: 'r1', queue: 'q', items: [] } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not configured');
  });

  it('agora_orchestrator_status returns isError when orch not provided', async () => {
    const fake = makeFakeClient();
    const server = makeServerWith(fake);
    const res = await callTool(server, 'agora_orchestrator_status', { runId: 'r1' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not configured');
  });

  it('agora_orchestrator_watch returns isError when orch not provided', async () => {
    const fake = makeFakeClient();
    const server = makeServerWith(fake);
    const res = await callTool(server, 'agora_orchestrator_watch', { runId: 'r1' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not configured');
  });
});

describe('agora-mcp registerAgoraTools — orchestrator tools (configured)', () => {
  it('agora_orchestrator_submit calls orch.submit with plan and default actor', async () => {
    const fake = makeFakeClient();
    const fakeOrch = makeFakeOrch();
    const server = makeServerWithOrch(fake, fakeOrch);
    const plan = { id: 'run-1', queue: 'q', items: [] };
    const res = await callTool(server, 'agora_orchestrator_submit', { plan });

    expect(fakeOrch.submit).toHaveBeenCalledTimes(1);
    expect(fakeOrch.submit).toHaveBeenCalledWith(plan, 'agent:mcp');
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe('run-1');
  });

  it('agora_orchestrator_submit uses provided actor', async () => {
    const fake = makeFakeClient();
    const fakeOrch = makeFakeOrch();
    const server = makeServerWithOrch(fake, fakeOrch);
    const plan = { id: 'run-2', queue: 'q', items: [] };
    await callTool(server, 'agora_orchestrator_submit', { plan, actor: 'agent:custom' });

    expect(fakeOrch.submit).toHaveBeenCalledWith(plan, 'agent:custom');
  });

  it('agora_orchestrator_status calls orch.status with runId', async () => {
    const fake = makeFakeClient();
    const fakeOrch = makeFakeOrch();
    const server = makeServerWithOrch(fake, fakeOrch);
    const res = await callTool(server, 'agora_orchestrator_status', { runId: 'run-1' });

    expect(fakeOrch.status).toHaveBeenCalledTimes(1);
    expect(fakeOrch.status).toHaveBeenCalledWith('run-1');
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.runId).toBe('run-1');
  });

  it('agora_orchestrator_status returns isError when runId missing', async () => {
    const fake = makeFakeClient();
    const fakeOrch = makeFakeOrch();
    const server = makeServerWithOrch(fake, fakeOrch);
    const res = await callTool(server, 'agora_orchestrator_status', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/runId/);
  });

  it('agora_orchestrator_watch calls orch.watch and returns last record', async () => {
    const fake = makeFakeClient();
    const fakeOrch = makeFakeOrch();
    const server = makeServerWithOrch(fake, fakeOrch);
    const res = await callTool(server, 'agora_orchestrator_watch', { runId: 'run-1', timeoutMs: 5000 });

    expect(fakeOrch.watch).toHaveBeenCalledTimes(1);
    expect(fakeOrch.watch).toHaveBeenCalledWith('run-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.runId).toBe('run-1');
  });

  it('agora_orchestrator_watch falls back to status when watch yields nothing', async () => {
    const fake = makeFakeClient();
    // Override watch to yield nothing (simulate timeout before any record)
    const fakeOrch = makeFakeOrch({
      watch: vi.fn(async function* (_runId: string, _opts?: unknown) {
        // yields nothing — simulates abort before any records
      }) as unknown as OperationsApi['watch'],
    });
    const server = makeServerWithOrch(fake, fakeOrch);
    const res = await callTool(server, 'agora_orchestrator_watch', { runId: 'run-1', timeoutMs: 100 });

    // Should have called status as fallback
    expect(fakeOrch.status).toHaveBeenCalledWith('run-1');
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.runId).toBe('run-1');
  });
});
