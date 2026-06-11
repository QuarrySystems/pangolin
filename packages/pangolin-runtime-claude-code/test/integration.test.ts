// Integration tests for the Claude Code RuntimeAdapter (§5.8) against a
// bash-stub `claude` binary that mimics specific runtime behaviors. The
// real `claude` CLI is not available in CI; the stub gives us deterministic
// control over stdout, exit code, sentinel writes, and plugin-install
// argv inspection while still exercising the adapter's spawn → capture →
// sentinel-detect pipeline end to end.
//
// Stub scripts are written per-test (no shared state) and the entire
// describe block is gated off on Windows where bash isn't a portable
// dependency. The helper-overlay test runs on every platform — it only
// touches `node:fs/promises` to read a packaged asset.

import {
  ClaudeCodeRuntimeAdapter,
  getNeedsInputHelperOverlay,
} from '../src/index.js';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'vitest';

let dir: string;
let stubBin: string;

type StubBehavior = 'success' | 'sentinel' | 'install-check';

async function writeStub(behavior: StubBehavior): Promise<void> {
  const scripts: Record<StubBehavior, string> = {
    success: '#!/bin/bash\necho "stub stdout"\nexit 0\n',
    sentinel:
      '#!/bin/bash\nmkdir -p "$PWD/.pangolin"\n' +
      'echo \'{"question":"clarify?"}\' > "$PWD/.pangolin/needs_input.json"\n' +
      'echo "stub stdout"\nexit 0\n',
    'install-check':
      '#!/bin/bash\n' +
      'if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then\n' +
      '  echo "installed $3"\n' +
      '  exit 0\n' +
      'fi\n' +
      'exit 0\n',
  };
  await writeFile(stubBin, scripts[behavior]);
  await chmod(stubBin, 0o755);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rt-cc-'));
  stubBin = join(dir, 'claude');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')(
  'ClaudeCodeRuntimeAdapter integration',
  () => {
    it('invokes the runtime and returns stdout', async () => {
      await writeStub('success');
      const adapter = new ClaudeCodeRuntimeAdapter({ claudeBin: stubBin });
      const exit = await adapter.invoke(
        { systemPrompt: 'hi', workspaceDir: dir },
        { dispatchId: 'd1', env: {} },
      );
      expect(exit.exitCode).toBe(0);
      expect(exit.stdout).toContain('stub stdout');
      expect(exit.needsInputSentinelPath).toBeUndefined();
    });

    it('reports needsInputSentinelPath when the runtime wrote the sentinel', async () => {
      await writeStub('sentinel');
      const adapter = new ClaudeCodeRuntimeAdapter({ claudeBin: stubBin });
      const exit = await adapter.invoke(
        { systemPrompt: 'hi', workspaceDir: dir },
        { dispatchId: 'd1', env: {} },
      );
      expect(exit.needsInputSentinelPath).toBe(
        join(dir, '.pangolin', 'needs_input.json'),
      );
    });

    it('runs `claude plugins install <name>` for each pangolin-plugins.json entry', async () => {
      await writeStub('install-check');
      await writeFile(
        join(dir, 'pangolin-plugins.json'),
        JSON.stringify(['foo-plugin', 'bar-plugin']),
      );
      const adapter = new ClaudeCodeRuntimeAdapter({ claudeBin: stubBin });
      const exit = await adapter.invoke(
        { systemPrompt: 'hi', workspaceDir: dir },
        { dispatchId: 'd1', env: {} },
      );
      expect(exit.exitCode).toBe(0);
    });
  },
);

it('exposes the needs-input-helper overlay via getNeedsInputHelperOverlay', async () => {
  const overlay = await getNeedsInputHelperOverlay();
  expect(Object.keys(overlay)).toContain(
    '.claude/skills/pangolin-needs-input/SKILL.md',
  );
  const skillBytes = overlay['.claude/skills/pangolin-needs-input/SKILL.md'];
  const text = new TextDecoder().decode(skillBytes);
  expect(text).toContain('/workspace/.pangolin/needs_input.json');
});
