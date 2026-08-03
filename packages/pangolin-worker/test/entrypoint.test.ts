// Tests for the worker entrypoint — the 14-step lifecycle orchestrator
// from spec §6.2.
//
// These tests exercise the full orchestration with stubs for the runtime
// adapter, storage, and the AWS Secrets Manager client. They cover the
// load-bearing exit-code paths declared in the task acceptance criteria:
// integrity failure, happy path with a clean runtime exit, valid
// needs_input sentinel, and a non-zero runtime exit with no sentinel.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker, type RunWorkerDeps } from '../src/entrypoint.js';
import { StructuredLogger } from '../src/logger.js';
import { LocalSecretStore } from '@quarry-systems/pangolin-secret-store';
import {
  computeContentHash,
  canonicalJsonString,
  buildDispatchRecordUri,
  type StorageProvider,
  type RuntimeAdapter,
  type RuntimeInvocation,
  type RuntimeExit,
  type LifecycleEvent,
  type PipelineSpec,
} from '@quarry-systems/pangolin-core';

/**
 * Minimal in-memory storage provider. Keyed by URI; returns the bytes
 * registered via `set()`. Now functional for `put()` so the escape path
 * can store the sentinel and (optionally) the patch artifact.
 */
class FakeStorage implements StorageProvider {
  readonly name = 'fake';
  private blobs = new Map<string, Uint8Array>();

  set(uri: string, bytes: Uint8Array): this {
    this.blobs.set(uri, bytes);
    return this;
  }

  async put(uri: string, contents: Uint8Array): Promise<{ contentHash: string }> {
    this.blobs.set(uri, contents);
    return { contentHash: computeContentHash(contents) };
  }

  async get(uri: string): Promise<Uint8Array> {
    const v = this.blobs.get(uri);
    if (!v) throw new Error(`fake storage: missing ${uri}`);
    return v;
  }

  async resolveLatest(): Promise<null> {
    return null;
  }

  async list(): Promise<[]> {
    return [];
  }

  async resolveByHash(): Promise<null> {
    return null;
  }

  /** Test helper: check if a URI was put to storage. */
  has(uri: string): boolean {
    return this.blobs.has(uri);
  }
}

/**
 * Serialize a capability bundle into the packed format produced by
 * `pangolin-client.registerCapability` (the worker's `unpackBundle` is its
 * inverse). Kept in sync by convention.
 */
function packBundle(name: string, files: Record<string, Uint8Array>): Uint8Array {
  const paths = Object.keys(files).sort();
  const entries = paths.map((path) => ({ path, size: files[path]!.byteLength }));
  const headerBytes = new TextEncoder().encode(JSON.stringify({ name, entries }) + '\n');
  const total = headerBytes.byteLength + paths.reduce((acc, p) => acc + files[p]!.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  out.set(headerBytes, 0);
  offset += headerBytes.byteLength;
  for (const p of paths) {
    out.set(files[p]!, offset);
    offset += files[p]!.byteLength;
  }
  return out;
}

function asJsonBytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

/** An externally-resolvable promise — used to hold an adapter mid-invoke. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Poll `pred` until it is true (or time out). Deterministic latch for async worker steps. */
async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Harness {
  workDir: string;
  adaptersRoot: string;
  storage: FakeStorage;
  env: Record<string, string>;
  events: LifecycleEvent[];
  adapter: RuntimeAdapter;
  invokeCalls: number;
  setRuntimeExit(exit: RuntimeExit): void;
}

async function setupHarness(opts?: {
  capabilityFiles?: Record<string, Uint8Array>;
  capabilityHashCorrect?: boolean; // default true
  verify?: { command: string; timeout?: number };
  /** Model baked into the subagent def (the def-level default). */
  subagentModel?: string;
  /** Called inside the stub adapter's invoke(), after incrementing the counter. */
  onInvoke?: (spec: RuntimeInvocation) => Promise<void>;
  /**
   * Input blobs to seed: each entry is stored in FakeStorage and added to
   * bundleRefs.inputs. `hashCorrect` defaults to true; set false to simulate
   * a tampered input (hash mismatch -> integrity-failed).
   */
  inputs?: Array<{ key: string; bytes: Uint8Array; hashCorrect?: boolean }>;
}): Promise<Harness> {
  const workDir = await mkdtemp(join(tmpdir(), 'entrypoint-work-'));
  const adaptersRoot = await mkdtemp(join(tmpdir(), 'entrypoint-adapters-'));

  // Write a stub runtime adapter on disk so the adapter-loader can find it
  // by name. The actual invoke() behavior is replaced via the injected
  // `adapter:` field on RunWorkerDeps — but adapter-loader is still part of
  // the 14-step flow, so we exercise its discovery code path.
  const adapterDir = join(adaptersRoot, 'claude-code');
  await mkdir(adapterDir, { recursive: true });
  await writeFile(
    join(adapterDir, 'index.js'),
    `export default function () {
       return {
         name: "claude-code",
         reservedPaths: [],
         invoke: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
       };
     };\n`,
    'utf-8',
  );

  const subagentDef: Record<string, unknown> = { name: 'alpha', systemPrompt: 'do work' };
  if (opts?.verify) subagentDef.verify = opts.verify;
  if (opts?.subagentModel) subagentDef.model = opts.subagentModel;
  const subagentUri = 'pangolin://ns/subagent/alpha/sha256:s';
  const subagentHash = computeContentHash(subagentDef);

  const capFiles = opts?.capabilityFiles ?? {
    'README.md': new TextEncoder().encode('hello\n'),
  };
  const capBytes = packBundle('cap-a', capFiles);
  const capUri = 'pangolin://ns/capability/cap-a/sha256:c';
  const correctCapHash = computeContentHash(capBytes);

  const storage = new FakeStorage();
  storage.set(subagentUri, asJsonBytes(subagentDef));
  storage.set(capUri, capBytes);

  const inputRefs: Array<{ key: string; uri: string; contentHash: string }> = [];
  if (opts?.inputs) {
    for (const inp of opts.inputs) {
      // synthetic uri; the contentHash field below is what's verified
      const inputUri = `pangolin://ns/input/${inp.key}/sha256:${inp.key}`;
      const correctHash = computeContentHash(inp.bytes);
      storage.set(inputUri, inp.bytes);
      inputRefs.push({
        key: inp.key,
        uri: inputUri,
        contentHash: inp.hashCorrect === false ? 'sha256:tampered' : correctHash,
      });
    }
  }

  const bundleRefs: Record<string, unknown> = {
    subagent: { uri: subagentUri, contentHash: subagentHash },
    capabilities: [
      {
        uri: capUri,
        contentHash: opts?.capabilityHashCorrect === false ? 'sha256:wrong' : correctCapHash,
      },
    ],
    env: [],
    ...(inputRefs.length > 0 ? { inputs: inputRefs } : {}),
  };

  const env: Record<string, string> = {
    PANGOLIN_DISPATCH_ID: 'd-1',
    PANGOLIN_NAMESPACE: 'ns',
    PANGOLIN_STORAGE_URI: 'file:///fake', // overridden by storage injection
    PANGOLIN_BUNDLE_REFS_JSON: JSON.stringify(bundleRefs),
    PANGOLIN_INPUT_JSON: JSON.stringify({ greeting: 'hi' }),
    PANGOLIN_RUNTIME_ADAPTER: 'claude-code',
  };

  const events: LifecycleEvent[] = [];

  let runtimeExit: RuntimeExit = { exitCode: 0, stdout: '', stderr: '' };
  let invokeCalls = 0;
  const adapter: RuntimeAdapter = {
    name: 'claude-code',
    reservedPaths: [],
    invoke: async (spec) => {
      invokeCalls++;
      if (opts?.onInvoke) await opts.onInvoke(spec);
      return runtimeExit;
    },
  };

  return {
    workDir,
    adaptersRoot,
    storage,
    env,
    events,
    adapter,
    get invokeCalls() {
      return invokeCalls;
    },
    setRuntimeExit(exit: RuntimeExit) {
      runtimeExit = exit;
    },
  };
}

function makeDeps(h: Harness, overrides?: Partial<RunWorkerDeps>): RunWorkerDeps {
  return {
    storage: h.storage,
    adapter: h.adapter,
    adaptersRoot: h.adaptersRoot,
    workspaceDir: h.workDir,
    secretsManagerClient: {
      send: async () => ({ SecretString: 'unused' }),
    } as never,
    onLifecycleEvent: (e) => {
      h.events.push(e);
    },
    ...overrides,
  };
}

// The SIGTERM cancel / handler-first / budget tests deliberately leave a
// `mainFlow` running after `runWorker` resolves — `Promise.race` does not cancel
// the loser, and production reaps the orphan via `process.exit`. In-process that
// orphan keeps writing into the workspace, so a plain recursive `rm` can race it
// and throw ENOTEMPTY (a fresh entry appears mid-walk). Retry until the orphan
// stops writing; it settles within tens of ms, so the bounded loop resolves as
// soon as the tree is quiescent (not on a fixed timer) and fails loudly if not.
async function rmWithRetry(dir: string, attempts = 40): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOTEMPTY' && i < attempts) {
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      throw err;
    }
  }
}

describe('runWorker', () => {
  let cleanupDirs: string[] = [];

  afterEach(async () => {
    for (const d of cleanupDirs) {
      await rmWithRetry(d);
    }
    cleanupDirs = [];
  });

  it('fails with integrity-failed when a capability hash mismatches', async () => {
    const h = await setupHarness({ capabilityHashCorrect: false });
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    const code = await runWorker(h.env, makeDeps(h));

    expect(code).not.toBe(0);
    const failed = h.events.find((e) => e.kind === 'dispatch.failed');
    expect(failed).toBeDefined();
    expect(failed && 'reason' in failed && failed.reason).toBe('integrity-failed');
    // The adapter must NOT have been invoked once integrity failed.
    expect(h.invokeCalls).toBe(0);
  });

  it('emits dispatch.failed on an early bundle-integrity failure when a callback is configured', async () => {
    const h = await setupHarness({ capabilityHashCorrect: false });
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.env.PANGOLIN_CALLBACK_URL = 'https://example.test/callback';
    h.env.PANGOLIN_CALLBACK_TOKEN_REF = 'arn:aws:secretsmanager:us-east-1:1:secret:hmac';

    const fetchCalls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      fetchCalls.push(String(input));
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const code = await runWorker(h.env, makeDeps(h, { fetchImpl }));

    expect(code).not.toBe(0);
    // On main the integrity failure returns before the HMAC key is resolved
    // (the emitter is keyless), so zero POST attempts are made. After the
    // fix, the SecretStore + emitter rebuild happens before bundle fetch, so
    // the callback URL is hit exactly once for the dispatch.failed event.
    expect(fetchCalls).toContain('https://example.test/callback');
  });

  it('resolves the bearer ref and sends Authorization on the callback POST', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.env.PANGOLIN_CALLBACK_URL = 'https://example.test/callback';
    h.env.PANGOLIN_CALLBACK_TOKEN_REF = 'arn:aws:secretsmanager:us-east-1:1:secret:hmac';
    h.env.PANGOLIN_CALLBACK_BEARER_REF = 'arn:aws:secretsmanager:us-east-1:1:secret:bearer';

    const secretStore = {
      name: 'fake',
      stage: async () => ({ ref: 'unused', ttlSeconds: 1 }),
      resolve: async (ref: string) => {
        if (ref === h.env.PANGOLIN_CALLBACK_TOKEN_REF) return 'HMAC_KEY';
        if (ref === h.env.PANGOLIN_CALLBACK_BEARER_REF) return 'RESOLVED_BEARER';
        throw new Error(`unknown ref ${ref}`);
      },
      cleanupByTag: async () => {},
    };

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init! });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const code = await runWorker(h.env, makeDeps(h, { fetchImpl, secretStore }));

    expect(code).toBe(0);
    const callbackPost = calls.find((c) => c.url === 'https://example.test/callback');
    expect(callbackPost).toBeDefined();
    expect((callbackPost!.init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer RESOLVED_BEARER',
    );
  });

  it('registers the resolved bearer token for redaction (positive control — asserts the CALL)', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.env.PANGOLIN_CALLBACK_URL = 'https://example.test/callback';
    h.env.PANGOLIN_CALLBACK_TOKEN_REF = 'arn:aws:secretsmanager:us-east-1:1:secret:hmac';
    h.env.PANGOLIN_CALLBACK_BEARER_REF = 'arn:aws:secretsmanager:us-east-1:1:secret:bearer';

    const secretStore = {
      name: 'fake',
      stage: async () => ({ ref: 'unused', ttlSeconds: 1 }),
      resolve: async (ref: string) => {
        if (ref === h.env.PANGOLIN_CALLBACK_TOKEN_REF) return 'HMAC_KEY';
        if (ref === h.env.PANGOLIN_CALLBACK_BEARER_REF) return 'RESOLVED_BEARER';
        throw new Error(`unknown ref ${ref}`);
      },
      cleanupByTag: async () => {},
    };

    const fetchImpl = (async () => new Response('ok', { status: 200 })) as typeof fetch;

    const registerSpy = vi.spyOn(StructuredLogger.prototype, 'registerSecret');
    let calledWith: unknown[];
    try {
      await runWorker(h.env, makeDeps(h, { fetchImpl, secretStore }));
      // Capture before mockRestore(): vitest's mockRestore() also resets the
      // recorded call history, so asserting after restore would vacuously see
      // zero calls regardless of whether registerSecret was actually invoked.
      calledWith = registerSpy.mock.calls.map((c) => c[0]);
    } finally {
      registerSpy.mockRestore();
    }

    expect(calledWith).toContain('RESOLVED_BEARER');
  });

  it('fails with fetch-failed when the bearer secretStore.resolve throws (mirrors the HMAC resolve-failure path)', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.env.PANGOLIN_CALLBACK_URL = 'https://example.test/callback';
    h.env.PANGOLIN_CALLBACK_TOKEN_REF = 'arn:aws:secretsmanager:us-east-1:1:secret:hmac';
    h.env.PANGOLIN_CALLBACK_BEARER_REF = 'arn:aws:secretsmanager:us-east-1:1:secret:bearer';

    const secretStore = {
      name: 'fake',
      stage: async () => ({ ref: 'unused', ttlSeconds: 1 }),
      resolve: async (ref: string) => {
        if (ref === h.env.PANGOLIN_CALLBACK_TOKEN_REF) return 'HMAC_KEY';
        if (ref === h.env.PANGOLIN_CALLBACK_BEARER_REF) {
          throw new Error('bearer secret not found');
        }
        throw new Error(`unknown ref ${ref}`);
      },
      cleanupByTag: async () => {},
    };

    const fetchImpl = (async () => new Response('ok', { status: 200 })) as typeof fetch;

    // Must resolve cleanly to a failWith exit — NOT throw out of runWorker —
    // so the caller always gets an exit code and a dispatch.failed event,
    // mirroring the mandatory HMAC resolve-failure path above.
    const code = await runWorker(h.env, makeDeps(h, { fetchImpl, secretStore }));

    expect(code).not.toBe(0);
    const failed = h.events.find((e) => e.kind === 'dispatch.failed');
    expect(failed).toBeDefined();
    expect(failed && 'reason' in failed && failed.reason).toBe('fetch-failed');
  });

  it('with no callbackBearerRef configured, resolves no bearer and sends no Authorization header', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.env.PANGOLIN_CALLBACK_URL = 'https://example.test/callback';
    h.env.PANGOLIN_CALLBACK_TOKEN_REF = 'arn:aws:secretsmanager:us-east-1:1:secret:hmac';

    const resolvedRefs: string[] = [];
    const secretStore = {
      name: 'fake',
      stage: async () => ({ ref: 'unused', ttlSeconds: 1 }),
      resolve: async (ref: string) => {
        resolvedRefs.push(ref);
        if (ref === h.env.PANGOLIN_CALLBACK_TOKEN_REF) return 'HMAC_KEY';
        throw new Error(`unknown ref ${ref}`);
      },
      cleanupByTag: async () => {},
    };

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init! });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const code = await runWorker(h.env, makeDeps(h, { fetchImpl, secretStore }));

    expect(code).toBe(0);
    expect(resolvedRefs).toEqual([h.env.PANGOLIN_CALLBACK_TOKEN_REF]);
    const callbackPost = calls.find((c) => c.url === 'https://example.test/callback');
    expect(callbackPost).toBeDefined();
    expect(callbackPost!.init.headers).not.toHaveProperty('Authorization');
  });

  it('runs the happy path: overlays bundles, invokes the adapter, emits started+finished, returns 0', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.setRuntimeExit({ exitCode: 0, stdout: 'done', stderr: '' });

    const code = await runWorker(h.env, makeDeps(h));

    expect(code).toBe(0);
    expect(h.invokeCalls).toBe(1);

    // Bundle file was overlaid to workspace
    const overlay = await readFile(join(h.workDir, 'README.md'), 'utf-8');
    expect(overlay).toBe('hello\n');

    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.started');
    expect(kinds).toContain('dispatch.finished');
    expect(kinds).not.toContain('dispatch.failed');
    expect(kinds).not.toContain('dispatch.needs_input');

    // Escape: the dispatch-record sentinel was uploaded (best-effort; may be
    // absent if git is unavailable in CI, so we only assert if it was written).
    const sentinelUri = buildDispatchRecordUri('ns', 'd-1', 'output.json');
    if (h.storage.has(sentinelUri)) {
      const sentinelBytes = await h.storage.get(sentinelUri);
      const parsed = JSON.parse(new TextDecoder().decode(sentinelBytes));
      expect(parsed.schemaVersion).toBe(1);
    }
  });

  it('runs the configured verify command and seals verify.passed into the sentinel', async () => {
    // `exit 0` is a shell builtin (sh + cmd) — no PATH needed in the verify shell.
    const h = await setupHarness({ verify: { command: 'exit 0' } });
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.setRuntimeExit({ exitCode: 0, stdout: '', stderr: '' });

    const code = await runWorker(h.env, makeDeps(h));
    expect(code).toBe(0);

    const sentinelUri = buildDispatchRecordUri('ns', 'd-1', 'output.json');
    const parsed = JSON.parse(new TextDecoder().decode(await h.storage.get(sentinelUri)));
    expect(parsed.verify).toBeDefined();
    expect(parsed.verify.passed).toBe(true);
  });

  it('treats verify.timeout:0 as unset (uses the default), not an instant timeout', async () => {
    const h = await setupHarness({ verify: { command: 'exit 0', timeout: 0 } });
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.setRuntimeExit({ exitCode: 0, stdout: '', stderr: '' });

    const code = await runWorker(h.env, makeDeps(h));
    expect(code).toBe(0);

    const sentinelUri = buildDispatchRecordUri('ns', 'd-1', 'output.json');
    const parsed = JSON.parse(new TextDecoder().decode(await h.storage.get(sentinelUri)));
    // Before the guard, timeout:0 → setTimeout(0) → instant SIGKILL → passed:false.
    expect(parsed.verify.passed).toBe(true);
  });

  it('is report-only: a failing verify seals passed:false but the dispatch still finishes 0', async () => {
    const h = await setupHarness({ verify: { command: 'exit 1' } });
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.setRuntimeExit({ exitCode: 0, stdout: '', stderr: '' });

    const code = await runWorker(h.env, makeDeps(h));

    // Report-only: red verify must NOT change the dispatch outcome.
    expect(code).toBe(0);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.finished');
    expect(kinds).not.toContain('dispatch.failed');

    const sentinelUri = buildDispatchRecordUri('ns', 'd-1', 'output.json');
    const parsed = JSON.parse(new TextDecoder().decode(await h.storage.get(sentinelUri)));
    expect(parsed.verify.passed).toBe(false);
  });

  it('logs escape.failed but still emits dispatch.finished and returns 0 when escape throws', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.setRuntimeExit({ exitCode: 0, stdout: '', stderr: '' });

    // Make storage.put throw so the escape upload fails (logged as escape.failed)
    const throws: FakeStorage = h.storage as unknown as FakeStorage;
    throws.put = async (_uri: string) => {
      throw new Error('storage unavailable');
    };

    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      });

    let code: number;
    try {
      code = await runWorker(h.env, makeDeps(h));
    } finally {
      spy.mockRestore();
    }

    // Escape failure must NOT change exit code or terminal event
    expect(code!).toBe(0);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.finished');
    expect(kinds).not.toContain('dispatch.failed');

    // escape.failed was logged
    const allLogs = writes.join('');
    expect(allLogs).toContain('escape.failed');
  });

  it('does not leak worker control-plane or ambient AWS credentials into the runtime env', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    // Seed the worker env with sensitive control-plane + ambient-credential
    // vars alongside benign ones the sub-agent legitimately needs.
    h.env.PANGOLIN_CALLBACK_TOKEN_REF = 'arn:aws:secretsmanager:us-east-1:1:secret:hmac';
    h.env.AWS_SECRET_ACCESS_KEY = 'super-secret-task-role-key';
    h.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/abc';
    h.env.AWS_REGION = 'us-east-1';
    h.env.LOG_LEVEL = 'debug';

    let captured: Record<string, string> | undefined;
    const deps = makeDeps(h);
    deps.adapter = {
      name: 'claude-code',
      reservedPaths: [],
      invoke: async (_spec, ctx) => {
        captured = ctx.env;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };

    const code = await runWorker(h.env, deps);

    expect(code).toBe(0);
    expect(captured).toBeDefined();
    // Worker control plane must not reach the sub-agent.
    expect(captured).not.toHaveProperty('PANGOLIN_CALLBACK_TOKEN_REF');
    expect(captured).not.toHaveProperty('PANGOLIN_BUNDLE_REFS_JSON');
    expect(captured).not.toHaveProperty('PANGOLIN_STORAGE_URI');
    // Ambient AWS task-role credentials must not be inherited.
    expect(captured).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(captured).not.toHaveProperty('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI');
    // Config + benign vars survive.
    expect(captured!.AWS_REGION).toBe('us-east-1');
    // Default-deny: LOG_LEVEL is not a built-in and was not allow-listed.
    expect(captured).not.toHaveProperty('LOG_LEVEL');
  });

  /**
   * The unit test in runtime-env-filter.test.ts pins the hard-deny on the filter.
   * This pins it through the real worker lifecycle, which is a different claim:
   * KNOWN-ISSUES 14 records a case where the filter behaved correctly and the var
   * still failed to reach `ctx.env`, because the wiring in between was wrong. A
   * safety control is only closed at the level it is asserted at.
   */
  it('a hard-denied credential does not reach the adapter even with PANGOLIN_RUNTIME_ENV_ALLOW=*', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    h.env.PANGOLIN_RUNTIME_ENV_ALLOW = '*';
    h.env.AWS_SECRET_ACCESS_KEY = 'super-secret-task-role-key';
    h.env.AWS_CONTAINER_AUTHORIZATION_TOKEN = 'bearer-super-secret';
    h.env.PANGOLIN_CALLBACK_TOKEN_REF = 'arn:aws:secretsmanager:us-east-1:1:secret:hmac';
    h.env.BENIGN_PASSTHROUGH = 'yes';

    let captured: Record<string, string> | undefined;
    const deps = makeDeps(h);
    deps.adapter = {
      name: 'claude-code',
      reservedPaths: [],
      invoke: async (_spec, ctx) => {
        captured = ctx.env;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };

    expect(await runWorker(h.env, deps)).toBe(0);
    // Control, and it is load-bearing: without it this test passes identically if
    // PANGOLIN_RUNTIME_ENV_ALLOW were silently dropped and no allow-list ran at all.
    expect(captured!.BENIGN_PASSTHROUGH).toBe('yes');
    expect(captured).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(captured).not.toHaveProperty('AWS_CONTAINER_AUTHORIZATION_TOKEN');
    expect(captured).not.toHaveProperty('PANGOLIN_CALLBACK_TOKEN_REF');
  });

  it('resolves per-dispatch secrets, injects them into the runtime env, and registers them for log redaction', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    const SECRET_VALUE = 'PER_DISPATCH_VALUE_XYZ';
    h.env.PANGOLIN_PER_DISPATCH_SECRET_REFS_JSON = JSON.stringify({
      SECRET_TOKEN: 'ref-1',
    });

    // Inject a SecretStore that resolves the ref to a known value.
    const secretStore = {
      name: 'fake',
      stage: async () => ({ ref: 'ref-1', ttlSeconds: 1 }),
      resolve: async (ref: string) =>
        ref === 'ref-1'
          ? SECRET_VALUE
          : (() => {
              throw new Error('unknown ref');
            })(),
      cleanupByTag: async () => {},
    };

    let captured: Record<string, string> | undefined;
    const deps: RunWorkerDeps = {
      ...makeDeps(h),
      secretStore,
      adapter: {
        name: 'claude-code',
        reservedPaths: [],
        invoke: async (_spec, ctx) => {
          captured = ctx.env;
          // Non-zero exit whose stderr echoes the secret — the failure path
          // logs stderr through the redacting StructuredLogger.
          return { exitCode: 7, stdout: '', stderr: `boom leaked=${SECRET_VALUE}` };
        },
      },
    };

    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      });
    try {
      await runWorker(h.env, deps);
    } finally {
      spy.mockRestore();
    }

    // Resolution + merge: the secret reached the sub-agent under its env name.
    expect(captured?.SECRET_TOKEN).toBe(SECRET_VALUE);
    // Redaction: the worker registered the value, so it never appears raw in
    // the worker's own log stream (the failure log echoed the stderr).
    const allLogs = writes.join('');
    expect(allLogs).not.toContain(SECRET_VALUE);
    expect(allLogs).toContain('<redacted:secret>');
  });

  it('selects LocalSecretStore when PANGOLIN_SECRET_STORE_KIND=local-file (no injected store)', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    // Stage a secret on disk via a real LocalSecretStore, as the client would.
    const secretsDir = await mkdtemp(join(tmpdir(), 'entrypoint-secrets-'));
    cleanupDirs.push(secretsDir);
    const staged = await new LocalSecretStore({ dir: secretsDir }).stage({
      name: 'd-1/DEPLOY_KEY',
      value: 'LOCAL_DEPLOY_VALUE',
      ttlSeconds: 60,
    });

    // Explicit store kind + the dir + the ref. Selection is driven by
    // PANGOLIN_SECRET_STORE_KIND, not by sniffing the storage URI.
    h.env.PANGOLIN_SECRET_STORE_KIND = 'local-file';
    h.env.PANGOLIN_SECRET_STORE_DIR = secretsDir;
    h.env.PANGOLIN_PER_DISPATCH_SECRET_REFS_JSON = JSON.stringify({
      DEPLOY_KEY: staged.ref,
    });

    let captured: Record<string, string> | undefined;
    // makeDeps injects no secretStore → the entrypoint default must pick
    // LocalSecretStore because PANGOLIN_SECRET_STORE_KIND=local-file is set.
    const deps: RunWorkerDeps = {
      ...makeDeps(h),
      adapter: {
        name: 'claude-code',
        reservedPaths: [],
        invoke: async (_spec, ctx) => {
          captured = ctx.env;
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
    };

    const code = await runWorker(h.env, deps);

    expect(code).toBe(0);
    expect(captured?.DEPLOY_KEY).toBe('LOCAL_DEPLOY_VALUE');
  });

  it('emits dispatch.needs_input and exits 0 when sentinel is valid', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    // Pre-stage a valid sentinel in the workspace and tell the adapter to
    // report its path on exit.
    const sentinelPath = join(h.workDir, 'needs_input.json');
    await writeFile(
      sentinelPath,
      JSON.stringify({ question: 'pick one', options: ['a', 'b'] }),
      'utf-8',
    );
    h.setRuntimeExit({
      exitCode: 0,
      stdout: '',
      stderr: '',
      needsInputSentinelPath: sentinelPath,
    });

    const code = await runWorker(h.env, makeDeps(h));

    expect(code).toBe(0);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.needs_input');
    expect(kinds).not.toContain('dispatch.finished');
    expect(kinds).not.toContain('dispatch.failed');
  });

  it('does not log the callback URL when a lifecycle delivery fails on the network', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.env.PANGOLIN_CALLBACK_URL = 'https://example.test/secret-path-token';
    h.env.PANGOLIN_CALLBACK_TOKEN_REF = 'arn:aws:secretsmanager:us-east-1:1:secret:hmac';

    // Force a network failure by injecting a fetchImpl that throws an error
    // embedding the callback URL — the delivery path must never surface it.
    const fetchImpl = (async () => {
      throw new Error(`connect ECONNREFUSED ${h.env.PANGOLIN_CALLBACK_URL}`);
    }) as typeof fetch;

    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      });

    let code: number;
    try {
      code = await runWorker(h.env, makeDeps(h, { fetchImpl }));
    } finally {
      spy.mockRestore();
    }

    expect(code).toBe(0);
    const allLogs = writes.join('');
    // A delivery-failure log line for the lifecycle event must have been written...
    expect(allLogs).toContain('lifecycle.delivery');
    // ...but it must never contain the raw callback URL.
    expect(allLogs).not.toContain(h.env.PANGOLIN_CALLBACK_URL);
  });

  it('emits dispatch.failed (worker-failed) when sentinel is malformed', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    const sentinelPath = join(h.workDir, 'needs_input.json');
    await writeFile(sentinelPath, '{not valid json', 'utf-8');
    h.setRuntimeExit({
      exitCode: 0,
      stdout: '',
      stderr: '',
      needsInputSentinelPath: sentinelPath,
    });

    const code = await runWorker(h.env, makeDeps(h));

    expect(code).not.toBe(0);
    const failed = h.events.find((e) => e.kind === 'dispatch.failed');
    expect(failed).toBeDefined();
    expect(failed && 'reason' in failed && failed.reason).toBe('worker-failed');
  });

  it('emits dispatch.failed with runtime exit code when adapter exits non-zero without sentinel', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.setRuntimeExit({ exitCode: 7, stdout: '', stderr: 'broken' });

    const code = await runWorker(h.env, makeDeps(h));

    expect(code).toBe(7);
    const failed = h.events.find((e) => e.kind === 'dispatch.failed');
    expect(failed).toBeDefined();
  });

  it('emits dispatch.finished with the adapter exit code on clean success', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.setRuntimeExit({ exitCode: 0, stdout: '', stderr: '' });

    await runWorker(h.env, makeDeps(h));

    const finished = h.events.find((e) => e.kind === 'dispatch.finished');
    expect(finished).toBeDefined();
    expect(finished && 'exitCode' in finished && finished.exitCode).toBe(0);
  });

  it('seals outputs/ deliverables written by the adapter into the uploaded sentinel', async () => {
    const h = await setupHarness({
      onInvoke: async (spec) => {
        await mkdir(join(spec.workspaceDir, 'outputs'), { recursive: true });
        await writeFile(join(spec.workspaceDir, 'outputs', 'report.txt'), 'done');
      },
    });
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    const code = await runWorker(h.env, makeDeps(h));
    expect(code).toBe(0);

    const sentinelUri = buildDispatchRecordUri('ns', 'd-1', 'output.json');
    const parsed = JSON.parse(new TextDecoder().decode(await h.storage.get(sentinelUri)));
    expect(parsed.outputs).toEqual([
      { path: 'report.txt', ref: expect.stringMatching(/^pangolin:\/\//) },
    ]);
    const refBytes = await h.storage.get(parsed.outputs[0].ref);
    expect(new TextDecoder().decode(refBytes)).toBe('done');
  });

  it('logs escape.failed and still succeeds with no outputs key when captureOutputs throws', async () => {
    const h = await setupHarness({
      onInvoke: async (spec) => {
        await mkdir(join(spec.workspaceDir, 'outputs'), { recursive: true });
        await writeFile(join(spec.workspaceDir, 'outputs', 'report.txt'), 'done');
      },
    });
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    // Make storage.put throw for artifact URIs so captureOutputs fails.
    const orig = h.storage.put.bind(h.storage);
    h.storage.put = async (uri: string, bytes: Uint8Array) => {
      // Only throw for artifact URIs (not the sentinel itself).
      if (uri.includes('/artifact/')) throw new Error('artifact upload failed');
      return orig(uri, bytes);
    };

    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      });

    let code: number;
    try {
      code = await runWorker(h.env, makeDeps(h));
    } finally {
      spy.mockRestore();
    }

    // Outcome must not change.
    expect(code!).toBe(0);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.finished');
    expect(kinds).not.toContain('dispatch.failed');

    // escape.failed was logged.
    const allLogs = writes.join('');
    expect(allLogs).toContain('escape.failed');

    // Sentinel was still written — but without outputs.
    const sentinelUri = buildDispatchRecordUri('ns', 'd-1', 'output.json');
    const parsed = JSON.parse(new TextDecoder().decode(await h.storage.get(sentinelUri)));
    expect(parsed.outputs).toBeUndefined();
  });

  it('produces a sentinel with no outputs key when the adapter writes nothing to outputs/', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.setRuntimeExit({ exitCode: 0, stdout: '', stderr: '' });

    const code = await runWorker(h.env, makeDeps(h));
    expect(code).toBe(0);

    const sentinelUri = buildDispatchRecordUri('ns', 'd-1', 'output.json');
    const parsed = JSON.parse(new TextDecoder().decode(await h.storage.get(sentinelUri)));
    expect(parsed.outputs).toBeUndefined();
  });

  it('materializes input refs at workspace/inputs/<key> before the adapter runs', async () => {
    const inputBytes = new TextEncoder().encode('diff --git a/x b/x');
    const h = await setupHarness({
      inputs: [{ key: 'patch.diff', bytes: inputBytes }],
      onInvoke: async (spec) => {
        const staged = await readFile(join(spec.workspaceDir, 'inputs', 'patch.diff'), 'utf8');
        if (!staged.startsWith('diff --git'))
          throw new Error('input not materialized before invoke');
      },
    });
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    expect(await runWorker(h.env, makeDeps(h))).toBe(0);
  });

  it('integrity failure: tampered input must NOT have the adapter invoked', async () => {
    const h = await setupHarness({
      inputs: [{ key: 'patch.diff', bytes: new TextEncoder().encode('hello'), hashCorrect: false }],
    });
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    const code = await runWorker(h.env, makeDeps(h));

    expect(code).not.toBe(0);
    const failed = h.events.find((e) => e.kind === 'dispatch.failed');
    expect(failed).toBeDefined();
    expect(failed && 'reason' in failed && failed.reason).toBe('integrity-failed');
    expect(h.invokeCalls).toBe(0);
  });

  it('rejects input key with path traversal and emits integrity-failed without invoking the adapter', async () => {
    const h = await setupHarness({
      inputs: [{ key: '../escape.txt', bytes: new TextEncoder().encode('bad') }],
    });
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    const code = await runWorker(h.env, makeDeps(h));

    expect(code).not.toBe(0);
    const failed = h.events.find((e) => e.kind === 'dispatch.failed');
    expect(failed).toBeDefined();
    expect(failed && 'reason' in failed && failed.reason).toBe('integrity-failed');
    // The adapter must NOT have been invoked — traversal is caught before overlay.
    expect(h.invokeCalls).toBe(0);
  });

  it('materialized input does not appear in the workspace patch (baseline captured after overlay)', async () => {
    // The adapter writes a NEW file so there is always a non-empty diff. This
    // ensures patchRef is present and the core assertion below always runs — the
    // test is deterministic whether or not git is available (if git is absent the
    // whole run is best-effort and the sentinel won't be stored; that is a
    // distinct concern covered by the best-effort escape path).
    const inputBytes = new TextEncoder().encode('diff --git a/x b/x\n');
    const h = await setupHarness({
      inputs: [{ key: 'patch.diff', bytes: inputBytes }],
      onInvoke: async (spec) => {
        // Write a new file the adapter "produced" — this produces a real diff.
        await writeFile(join(spec.workspaceDir, 'agent-output.txt'), 'result\n');
      },
    });
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.setRuntimeExit({ exitCode: 0, stdout: '', stderr: '' });

    const code = await runWorker(h.env, makeDeps(h));
    expect(code).toBe(0);

    // The sentinel must have been stored (writeSentinel always runs on success).
    const sentinelUri = buildDispatchRecordUri('ns', 'd-1', 'output.json');
    expect(h.storage.has(sentinelUri)).toBe(true);
    const parsed = JSON.parse(new TextDecoder().decode(await h.storage.get(sentinelUri)));

    // The adapter wrote a new file so a patch must exist.
    expect(parsed.patchRef).toBeDefined();
    const patchBytes = await h.storage.get(parsed.patchRef);
    const patchText = new TextDecoder().decode(patchBytes);
    // The patch must show the new agent-produced file.
    expect(patchText).toContain('agent-output.txt');
    // The pre-existing input file (overlaid before baseline) must NOT appear
    // as a change — it was staged into the baseline tree, so the diff is clean.
    expect(patchText).not.toContain('inputs/patch.diff');
  });

  it('PANGOLIN_MODEL overrides the subagent def model in the invocation and is stripped from the runtime env', async () => {
    const h = await setupHarness({ subagentModel: 'def-model' });
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.env.PANGOLIN_MODEL = 'cfg-model';

    let capturedSpec: RuntimeInvocation | undefined;
    let capturedEnv: Record<string, string> | undefined;
    const deps = makeDeps(h);
    deps.adapter = {
      name: 'claude-code',
      reservedPaths: [],
      invoke: async (spec, ctx) => {
        capturedSpec = spec;
        capturedEnv = ctx.env;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };

    const code = await runWorker(h.env, deps);

    expect(code).toBe(0);
    // The runtime-effect override: cfg.model wins over the def's model.
    expect(capturedSpec).toBeDefined();
    expect(capturedSpec!.model).toBe('cfg-model');
    // Firewall regression: PANGOLIN_MODEL is control plane — stripped like all PANGOLIN_*.
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv).not.toHaveProperty('PANGOLIN_MODEL');
  });

  it('without PANGOLIN_MODEL the subagent def model flows to the invocation unchanged', async () => {
    const h = await setupHarness({ subagentModel: 'def-model' });
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    let capturedSpec: RuntimeInvocation | undefined;
    const deps = makeDeps(h);
    deps.adapter = {
      name: 'claude-code',
      reservedPaths: [],
      invoke: async (spec) => {
        capturedSpec = spec;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };

    const code = await runWorker(h.env, deps);

    expect(code).toBe(0);
    expect(capturedSpec).toBeDefined();
    expect(capturedSpec!.model).toBe('def-model');
  });

  it('declared valid script-only pipeline: runs without invoking the adapter, emits dispatch.finished, sentinel carries blocks[]', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    // Build a script-only pipeline that writes a sentinel-visible output file.
    // The outputs/ dir is inside workDir (injected as workspaceDir).
    const outputsPath = join(h.workDir, 'outputs', 'result.txt').replace(/\\/g, '/');
    const pipelineSpec: PipelineSpec = {
      schemaVersion: 1,
      id: 'test.script-only',
      blocks: [
        {
          kind: 'script',
          command: `node -e "require('fs').mkdirSync('${join(h.workDir, 'outputs').replace(/\\/g, '/')}', {recursive:true}); require('fs').writeFileSync('${outputsPath}', 'done')"`,
        },
        { kind: 'capture', what: 'outputs' },
      ],
    };

    // Seed the pipeline spec in fake storage. The bundle-fetcher JSON.parses
    // the bytes, then calls verifyContentHash(parsedObj, contentHash). The
    // client stores canonicalJsonString bytes; the hash is over the parsed object.
    const pipelineBytes = new TextEncoder().encode(canonicalJsonString(pipelineSpec));
    const pipelineHash = computeContentHash(pipelineSpec); // object hash, not bytes hash
    const pipelineUri = 'pangolin://ns/pipeline/test.script-only/sha256:p';
    h.storage.set(pipelineUri, pipelineBytes);

    // Inject the pipeline ref into bundleRefs.
    const bundleRefs = JSON.parse(h.env.PANGOLIN_BUNDLE_REFS_JSON!) as Record<string, unknown>;
    bundleRefs.pipeline = { uri: pipelineUri, contentHash: pipelineHash };
    h.env.PANGOLIN_BUNDLE_REFS_JSON = JSON.stringify(bundleRefs);

    const code = await runWorker(h.env, makeDeps(h));

    // dispatch.finished, not failed.
    expect(code).toBe(0);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.finished');
    expect(kinds).not.toContain('dispatch.failed');

    // Adapter was NEVER invoked — no agent block in the pipeline.
    expect(h.invokeCalls).toBe(0);

    // Sentinel carries blocks[] (declared: true) and outputs.
    const sentinelUri = buildDispatchRecordUri('ns', 'd-1', 'output.json');
    expect(h.storage.has(sentinelUri)).toBe(true);
    const parsed = JSON.parse(new TextDecoder().decode(await h.storage.get(sentinelUri)));
    expect(Array.isArray(parsed.blocks)).toBe(true);
    expect(parsed.blocks.length).toBeGreaterThan(0);
  });

  it('declared invalid spec (empty blocks) seeded in storage → integrity-failed, exit 1, adapter never invoked, no sentinel', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    // Build an INVALID pipeline spec: blocks: [] fails validatePipelineSpec.
    const invalidSpec = {
      schemaVersion: 1,
      id: 'test.invalid',
      blocks: [],
    };

    const pipelineBytes = new TextEncoder().encode(canonicalJsonString(invalidSpec));
    const pipelineHash = computeContentHash(invalidSpec);
    const pipelineUri = 'pangolin://ns/pipeline/test.invalid/sha256:q';
    h.storage.set(pipelineUri, pipelineBytes);

    const bundleRefs = JSON.parse(h.env.PANGOLIN_BUNDLE_REFS_JSON!) as Record<string, unknown>;
    bundleRefs.pipeline = { uri: pipelineUri, contentHash: pipelineHash };
    h.env.PANGOLIN_BUNDLE_REFS_JSON = JSON.stringify(bundleRefs);

    const code = await runWorker(h.env, makeDeps(h));

    // Must exit non-zero.
    expect(code).toBe(1);

    // dispatch.failed with integrity-failed reason.
    const failed = h.events.find((e) => e.kind === 'dispatch.failed');
    expect(failed).toBeDefined();
    expect(failed && 'reason' in failed && failed.reason).toBe('integrity-failed');

    // Adapter must never have been invoked.
    expect(h.invokeCalls).toBe(0);

    // No sentinel stored.
    const sentinelUri = buildDispatchRecordUri('ns', 'd-1', 'output.json');
    expect(h.storage.has(sentinelUri)).toBe(false);
  });

  // ── Slice C: SIGTERM-driven graceful cancellation (spec §4.1–4.2, §5, §6) ──

  it('regression: a terminationSignal that never aborts leaves the run byte-identical (finished, 0)', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.setRuntimeExit({ exitCode: 0, stdout: '', stderr: '' });

    const ctrl = new AbortController(); // signal present but never fired
    const code = await runWorker(h.env, makeDeps(h, { terminationSignal: ctrl.signal }));

    expect(code).toBe(0);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.finished');
    expect(kinds).not.toContain('dispatch.cancelled');
  });

  it('cancel path: SIGTERM while the adapter runs (no terminal produced) emits exactly one dispatch.cancelled and resolves 0', async () => {
    const gate = deferred(); // holds the adapter mid-invoke so no terminal is produced
    const h = await setupHarness({ onInvoke: async () => gate.promise });
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    const ctrl = new AbortController();
    const runP = runWorker(h.env, makeDeps(h, { terminationSignal: ctrl.signal }));

    // Abort only once the adapter is actually running (past dispatch.started).
    await waitFor(() => h.invokeCalls === 1);
    ctrl.abort();
    const code = await runP;
    gate.resolve(); // let the (now-suppressed) mainFlow unwind

    expect(code).toBe(0);
    const kinds = h.events.map((e) => e.kind);
    // dispatch.started is NON-terminal and DOES appear; assert on the terminal set.
    const terminals = kinds.filter((k) =>
      ['dispatch.finished', 'dispatch.failed', 'dispatch.needs_input'].includes(k),
    );
    expect(terminals).toEqual([]);
    expect(kinds.filter((k) => k === 'dispatch.cancelled')).toHaveLength(1);
  });

  it('main-first flush: SIGTERM as the dispatch.finished terminal is emitted takes the flush branch — finished stands, no cancelled', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.setRuntimeExit({ exitCode: 0, stdout: '', stderr: '' });

    const ctrl = new AbortController();
    const deps = makeDeps(h, {
      terminationSignal: ctrl.signal,
      onLifecycleEvent: (e) => {
        h.events.push(e);
        // SIGTERM arrives exactly as the terminal begins emitting: the claim is
        // already taken, so the handler must flush rather than emit cancelled.
        if (e.kind === 'dispatch.finished') ctrl.abort();
      },
    });

    const code = await runWorker(h.env, deps);

    expect(code).toBe(0);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.finished');
    expect(kinds).not.toContain('dispatch.cancelled');
  });

  it('handler-first: a trailing provider-failed terminal (adapter exits non-zero after cancel) is suppressed', async () => {
    const gate = deferred();
    const h = await setupHarness({ onInvoke: async () => gate.promise });
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    // Non-zero exit → the DIRECT provider-failed tail (entrypoint :570), which
    // does NOT go through failWith. It only fires AFTER cancel releases the adapter.
    h.setRuntimeExit({ exitCode: 9, stdout: '', stderr: 'boom' });

    const ctrl = new AbortController();
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      });

    let code: number;
    try {
      const deps = makeDeps(h, {
        terminationSignal: ctrl.signal,
        onLifecycleEvent: (e) => {
          h.events.push(e);
          // Once the handler's cancel lands, let the adapter finish non-zero.
          if (e.kind === 'dispatch.cancelled') gate.resolve();
        },
      });
      const runP = runWorker(h.env, deps);
      await waitFor(() => h.invokeCalls === 1);
      ctrl.abort();
      code = await runP;
      // The provider-failed branch logs to the worker stream BEFORE the claim
      // guard (with no await between) — so once that log appears, the guard has
      // already run and suppressed the emit. This makes the assertion below a
      // real suppression check, not a "hasn't happened yet" false pass.
      await waitFor(() => writes.join('').includes('provider-failed'));
    } finally {
      spy.mockRestore();
    }

    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.cancelled');
    // The trailing provider-failed terminal was suppressed (never emitted).
    const terminals = kinds.filter((k) =>
      ['dispatch.finished', 'dispatch.failed', 'dispatch.needs_input'].includes(k),
    );
    expect(terminals).toEqual([]);
    expect(code!).toBe(0);
  });

  it('handler-first: a trailing failWith terminal (adapter throws after cancel) is suppressed', async () => {
    const gate = deferred();
    const h = await setupHarness({
      // Block, then throw once released → mainFlow's catch → failWith('worker-failed').
      onInvoke: async () => {
        await gate.promise;
        throw new Error('adapter blew up post-cancel');
      },
    });
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    const ctrl = new AbortController();
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      });

    let code: number;
    try {
      const deps = makeDeps(h, {
        terminationSignal: ctrl.signal,
        onLifecycleEvent: (e) => {
          h.events.push(e);
          if (e.kind === 'dispatch.cancelled') gate.resolve();
        },
      });
      const runP = runWorker(h.env, deps);
      await waitFor(() => h.invokeCalls === 1);
      ctrl.abort();
      code = await runP;
      // failWith logs the reason before its claim guard — same rationale as above.
      await waitFor(() => writes.join('').includes('worker-failed'));
    } finally {
      spy.mockRestore();
    }

    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.cancelled');
    const terminals = kinds.filter((k) =>
      ['dispatch.finished', 'dispatch.failed', 'dispatch.needs_input'].includes(k),
    );
    expect(terminals).toEqual([]);
    expect(code!).toBe(0);
  });

  it('budget + backstop: a hung callback aborts the cancel emit at ~2 s (reason aborted) and persists the undelivered record', async () => {
    const gate = deferred(); // adapter stays in-flight so mainFlow produces no terminal
    const h = await setupHarness({ onInvoke: async () => gate.promise });
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.env.PANGOLIN_CALLBACK_URL = 'https://example.test/callback';
    h.env.PANGOLIN_CALLBACK_TOKEN_REF = 'arn:aws:secretsmanager:us-east-1:1:secret:hmac';

    const secretStore = {
      name: 'fake',
      stage: async () => ({ ref: 'unused', ttlSeconds: 1 }),
      resolve: async () => 'HMAC_KEY',
      cleanupByTag: async () => {},
    };

    // Only the cancel callback hangs (settling on its signal's abort); every
    // earlier lifecycle POST — notably dispatch.started — responds 200 so the
    // orchestration reaches the adapter. The event kind is in the POST body.
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      if (body.includes('dispatch.cancelled')) {
        return new Promise((_res, reject) => {
          const sig = init?.signal;
          if (sig)
            sig.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as typeof fetch;

    const ctrl = new AbortController();
    const runP = runWorker(
      h.env,
      makeDeps(h, { terminationSignal: ctrl.signal, fetchImpl, secretStore }),
    );

    // Abort once the adapter is running so storage is constructed and mainFlow
    // holds no terminal — the handler wins the claim and emits cancelled.
    await waitFor(() => h.invokeCalls === 1);
    ctrl.abort();
    const code = await runP; // resolves after the ~2 s budget aborts the hung fetch
    gate.resolve();

    expect(code).toBe(0);

    // The durable backstop (slice B) persisted the undelivered cancel record...
    const undeliveredUri = buildDispatchRecordUri(
      'ns',
      'd-1',
      'undelivered/dispatch.cancelled.json',
    );
    expect(h.storage.has(undeliveredUri)).toBe(true);
    const record = JSON.parse(new TextDecoder().decode(await h.storage.get(undeliveredUri)));
    expect(record.event.kind).toBe('dispatch.cancelled');
    // ...and the delivery outcome reason is the external-abort classification.
    expect(record.outcome.reason).toBe('aborted');
  }, 10000);
});
