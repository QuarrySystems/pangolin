# Getting started

From zero to first successful dispatch on local Docker. Assumes you have a
checked-out clone of this repo and a working Docker Desktop / engine.

If you'd rather read the design first, the MVP spec
(`docs/superpowers/specs/2026-05-21-agora-mvp-design.md`) is the canonical
source. This page is the runbook.

## 1. Build the worker image

The worker runs in every dispatch. Build it once:

```bash
docker build -t ghcr.io/quarrysystems/agora-worker:latest \
  -f docker/agora-worker/Dockerfile .
```

That tag — `ghcr.io/quarrysystems/agora-worker:latest` — is what every
example below references. Replace it with your own digest in production
(`LocalDockerProvider`'s `allowUnpinnedImage` is dev-only).

## 2. Build the workspace packages

```bash
pnpm install
pnpm -r build
```

The CLI, MCP server, and providers all live in `packages/` and are private
to the workspace. Nothing on npm yet, so consumers run them by absolute path
(see step 5).

## 3. Create your deploy dir

Pick (or use) a project directory where you'll run dispatches from. This is
"the deploy dir." It needs one file: `agora.config.mjs` exporting a
configured `AgoraClient`.

Minimal local-Docker config:

```javascript
// my-deploy/agora.config.mjs
import {
  AgoraClient,
  NoopCredentialProvider,
  StdoutResultSink,
} from 'file:///ABS/PATH/TO/agora/packages/agora-client/dist/index.js';
import { LocalStorageProvider } from 'file:///ABS/PATH/TO/agora/packages/agora-storage-local/dist/index.js';
import { LocalDockerProvider } from 'file:///ABS/PATH/TO/agora/packages/agora-providers-local-docker/dist/index.js';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Stable storage root so the CLI and MCP server share one catalog.
// mkdtemp here would give each process a fresh, empty registry.
const storageRoot = join(homedir(), '.agora', 'my-deploy');
await mkdir(storageRoot, { recursive: true });

const client = new AgoraClient({
  namespace: 'my-deploy',
  compute: {
    'local-docker': new LocalDockerProvider({ allowUnpinnedImage: true }),
  },
  credentials: { none: new NoopCredentialProvider() },
  storage: new LocalStorageProvider({ rootDir: storageRoot }),
  targets: { local: { compute: 'local-docker', credentials: 'none' } },
  resultSink: new StdoutResultSink(),
});

export default client;
```

The `file://` URLs are because the `@quarry-systems/*` packages are
unpublished workspace packages. Once they ship on npm, switch to bare
specifiers and `pnpm add @quarry-systems/agora-client` etc.

## 4. Set `ANTHROPIC_API_KEY`

The default Claude Code runtime adapter runs `claude --print`, which needs
an API key. Without it, dispatches reach the runtime step and return
`provider-failed` with exit non-zero — the setup script still runs, so
you'll see anything it printed in stdout, but the adapter step fails.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

The MCP server (next step) inherits this from whatever shell launches
Claude Code, so set it persistently if you want to use it from the AI
surface — Windows user env var, `~/.bashrc`, etc.

## 5. Wire up the CLI

Two ways. Pick one.

**Bash alias (per-shell-session):**

```bash
alias agora='node /ABS/PATH/TO/agora/packages/agora-cli/dist/index.js'
```

Add to `~/.bashrc` to make it persistent.

**Direct invocation:**

```bash
node /ABS/PATH/TO/agora/packages/agora-cli/dist/index.js capabilities list
```

The CLI scans `cwd` for `agora.config.{ts,js,mjs}`, so always run it from
your deploy dir.

## 6. Smoke test — register and dispatch

```bash
cd ~/path/to/my-deploy

# Register a tiny capability + subagent + env
mkdir -p caps/hello-cap
printf '#!/bin/sh\necho "hello from agora"\n' > caps/hello-cap/agora-setup.sh
agora capabilities register --name hello-cap --from caps/hello-cap
agora subagent register --name greeter \
  --system-prompt "Say hi and exit." --capability hello-cap
agora env register --name minimal --value LOG_LEVEL=info \
  --secret ANTHROPIC_API_KEY=inline:$ANTHROPIC_API_KEY

# Dispatch
agora dispatch run --target local --subagent greeter --env minimal \
  --worker-image ghcr.io/quarrysystems/agora-worker:latest
```

You should see structured-log JSON: `worker.boot`, `setup-script.ran`
(with "hello from agora" in its stdout field), and `dispatch.finished` with
`exitCode: 0`.

## 7. (Optional) Wire up the MCP server

So Claude Code sessions in the deploy dir can dispatch via the AI surface.
Add to `.mcp.json` (or `~/.claude/settings.json` for global):

```json
{
  "mcpServers": {
    "agora": {
      "command": "node",
      "args": ["/ABS/PATH/TO/agora/packages/agora-mcp/dist/bin.js"],
      "cwd": "/ABS/PATH/TO/my-deploy"
    }
  }
}
```

No `env:` block — the server inherits the shell that launched Claude Code,
including `ANTHROPIC_API_KEY` and any `DOCKER_HOST` you've set for
cross-machine dispatch.

Reload Claude Code; you should see six `agora_*` tools (`agora_dispatch`,
`agora_dispatch_describe`, `agora_dispatch_cancel`, plus three `*_list`
reads that currently throw `NOT_IMPLEMENTED` — known limitation).

## What now

- [Capability recipes](capability-recipes.md) — where to put files for the
  worker to pick them up.
- [Sync providers](sync-providers.md) — bulk-import an existing
  `.claude/skills/` or `.claude/agents/` tree without writing capabilities
  by hand.
- [Dispatch lifecycle](dispatch-lifecycle.md) — what each stdout event
  means, what each failure reason maps to.
- [Remote dispatch over SSH](remote-dispatch-windows.md) — orchestrate
  from one machine, run workers on another.
- [Writing a provider](writing-a-provider.md) — plug in a new compute
  backend, storage layer, credential source, or result sink.
- [needs_input](needs-input.md) — how a sub-agent pauses for clarification
  and how to resume it.
