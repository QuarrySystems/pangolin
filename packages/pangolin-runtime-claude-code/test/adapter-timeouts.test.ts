// The adapter applies the agent-phase and plugin-install bounds (KNOWN-ISSUES 9).
//
// Before this, `PANGOLIN_AGENT_TIMEOUT_SECONDS` and
// `PANGOLIN_PLUGIN_INSTALL_TIMEOUT_SECONDS` were emitted by pangolin-client and
// consumed by nothing, so a caller's `timeoutSeconds` bounded nothing
// worker-side and a hung agent ran until someone noticed.
//
// The bounds arrive on `RuntimeContext`, NOT in `ctx.env`. That distinction is
// the whole reason this file exists: the worker's `filterRuntimeEnv` is
// default-deny and strips every `PANGOLIN_*` variable, so an adapter reading
// these out of `ctx.env` would silently always fall back to its defaults — a
// fix that looks right and does nothing. A test pins that below.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/claude-spawn.js', () => ({
  spawnClaude: vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '' })),
  buildClaudeArgs: () => [],
  TIMEOUT_EXIT_CODE: 124,
}));
vi.mock('../src/plugin-installer.js', () => ({
  installPluginsFromManifest: vi.fn(async () => {}),
}));
vi.mock('../src/sentinel-detector.js', () => ({
  detectNeedsInputSentinel: vi.fn(async () => undefined),
}));

import { ClaudeCodeRuntimeAdapter } from '../src/adapter.js';
import { spawnClaude } from '../src/claude-spawn.js';
import { installPluginsFromManifest } from '../src/plugin-installer.js';

const spawnMock = vi.mocked(spawnClaude);
const installMock = vi.mocked(installPluginsFromManifest);

type Ctx = Parameters<ClaudeCodeRuntimeAdapter['invoke']>[1];

const invocation = {
  workspaceDir: '/ws',
  systemPrompt: 'sp',
} as unknown as Parameters<ClaudeCodeRuntimeAdapter['invoke']>[0];

async function invokeWith(ctx: Partial<Ctx>) {
  const adapter = new ClaudeCodeRuntimeAdapter();
  await adapter.invoke(invocation, {
    dispatchId: 'd1',
    env: {},
    ...ctx,
  } as Ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ClaudeCodeRuntimeAdapter timeout wiring', () => {
  it('applies ctx.agentTimeoutSeconds to the claude spawn', async () => {
    await invokeWith({ agentTimeoutSeconds: 1800 });
    expect(spawnMock.mock.calls[0][0]).toMatchObject({ timeoutSeconds: 1800 });
  });

  it('applies ctx.pluginInstallTimeoutSeconds to the plugin installer', async () => {
    await invokeWith({ pluginInstallTimeoutSeconds: 90 });
    expect(installMock.mock.calls[0][0]).toMatchObject({ timeoutSeconds: 90 });
  });

  it('reads the two bounds independently of each other', async () => {
    await invokeWith({ agentTimeoutSeconds: 600, pluginInstallTimeoutSeconds: 60 });
    expect(spawnMock.mock.calls[0][0]).toMatchObject({ timeoutSeconds: 600 });
    expect(installMock.mock.calls[0][0]).toMatchObject({ timeoutSeconds: 60 });
  });

  it('falls back to a bound — never to unbounded — when the context supplies none', async () => {
    // The standalone-adapter path. "No bound given" must not mean "no bound".
    await invokeWith({});
    expect(spawnMock.mock.calls[0][0]).toMatchObject({ timeoutSeconds: 7200 });
    expect(installMock.mock.calls[0][0]).toMatchObject({ timeoutSeconds: 300 });
  });

  it('ignores the same names in ctx.env, which cannot carry them', async () => {
    // The worker's env firewall is default-deny and strips every PANGOLIN_*
    // var, so these never actually arrive this way. Pinning it here stops a
    // future reader "helpfully" reading ctx.env and reintroducing a bound that
    // silently never applies.
    await invokeWith({
      env: {
        PANGOLIN_AGENT_TIMEOUT_SECONDS: '11',
        PANGOLIN_PLUGIN_INSTALL_TIMEOUT_SECONDS: '22',
      },
    });
    expect(spawnMock.mock.calls[0][0]).toMatchObject({ timeoutSeconds: 7200 });
    expect(installMock.mock.calls[0][0]).toMatchObject({ timeoutSeconds: 300 });
  });

  it('prefers an explicit context bound over the default', async () => {
    await invokeWith({ agentTimeoutSeconds: 1 });
    expect(spawnMock.mock.calls[0][0]).toMatchObject({ timeoutSeconds: 1 });
  });
});
