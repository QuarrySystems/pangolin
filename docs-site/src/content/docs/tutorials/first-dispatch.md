---
title: Your first dispatch
description: From a clean clone to one successful agent dispatch on local Docker.
---
import { Steps } from '@astrojs/starlight/components';

This tutorial takes you from a fresh clone of the repo to one successful agent
dispatch running in a local Docker container. You will build the worker image,
write an `agora.config.mjs`, wire up the CLI, register a capability, a subagent,
and an env bundle, and then dispatch.

Everything here runs against the local-only provider stack — `LocalDockerProvider`
for compute, `LocalStorageProvider` for artifacts, `NoopCredentialProvider` for
credentials, and `StdoutResultSink` for results. No AWS, no remote anything. If
you have Docker running, you should reach a green dispatch in well under thirty
minutes.

## Before you start

You need:

- Node.js 20+ and pnpm 9.
- Docker Desktop (or an equivalent engine) running locally.
- An `ANTHROPIC_API_KEY`. The stock worker image runs the `claude-code` runtime
  adapter, which spawns the `claude` binary. Without a key the adapter exits
  non-zero and the dispatch is reported as `provider-failed` — the setup step
  still runs, so you will see its output, but the run fails. This is expected
  v0.1 behavior: the credential is needed by the adapter, not by agora's own
  machinery.

## Build and dispatch

Follow these steps in order.

<Steps>

1. **Build the worker image.**

   The worker runs in every dispatch. Build it once from the repo root:

   ```bash
   docker build -t ghcr.io/quarrysystems/agora-worker:latest \
     -f docker/agora-worker/Dockerfile .
   ```

   That tag — `ghcr.io/quarrysystems/agora-worker:latest` — is what every
   step below references. In production you replace it with your own
   digest-pinned image; `LocalDockerProvider`'s `allowUnpinnedImage` option is
   dev-only.

2. **Build the workspace packages.**

   ```bash
   pnpm install
   pnpm -r build
   ```

   The CLI, MCP server, and providers all live in `packages/` and are private
   to the workspace. Nothing ships on npm yet, so you reference them by
   absolute path (the next step).

3. **Create your deploy dir.**

   Pick a project directory to run dispatches from. This is "the deploy dir."
   It needs one file: `agora.config.mjs`, exporting a configured `AgoraClient`
   as the default export.

   Write this minimal local-Docker config:

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

   The `file://` URLs are there because the `@quarry-systems/*` packages are
   unpublished workspace packages. Once they ship on npm you switch to bare
   specifiers and `pnpm add @quarry-systems/agora-client`.

4. **Set `ANTHROPIC_API_KEY`.**

   The default Claude Code runtime adapter runs `claude --print`, which needs
   an API key:

   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ```

   The MCP server (last step) inherits this from whatever shell launches Claude
   Code, so set it persistently if you want to use it from the AI surface — a
   Windows user env var, `~/.bashrc`, etc.

5. **Wire up the CLI.**

   The CLI scans `cwd` for `agora.config.{ts,js,mjs}`, so always run it from
   your deploy dir. Make an alias:

   ```bash
   alias agora='node /ABS/PATH/TO/agora/packages/agora-cli/dist/index.js'
   ```

   Add it to `~/.bashrc` to make it persistent. Confirm it loads your config:

   ```bash
   cd ~/path/to/my-deploy
   agora capabilities list
   ```

6. **Register a capability, a subagent, and an env bundle.**

   From your deploy dir:

   ```bash
   # Register a tiny capability + subagent + env
   mkdir -p caps/hello-cap
   printf '#!/bin/sh\necho "hello from agora"\n' > caps/hello-cap/agora-setup.sh
   agora capabilities register --name hello-cap --from caps/hello-cap
   agora subagent register --name greeter \
     --system-prompt "Say hi and exit." --capability hello-cap
   agora env register --name minimal --value LOG_LEVEL=info \
     --secret ANTHROPIC_API_KEY=inline:$ANTHROPIC_API_KEY
   ```

   Each `register` prints the resulting ref as JSON, including a `contentHash` —
   that hash is the audit trail proving exactly which bytes were registered.

7. **Dispatch.**

   ```bash
   agora dispatch run --target local --subagent greeter --env minimal \
     --worker-image ghcr.io/quarrysystems/agora-worker:latest
   ```

   You will see structured-log JSON: `worker.boot`, then `setup-script.ran`
   (with `hello from agora` in its `stdout` field), and finally
   `dispatch.finished` with `exitCode: 0`. The CLI exits non-zero if the
   dispatch reports a failure.

</Steps>

That is one successful dispatch end-to-end: a registered capability, a subagent
bound to it, an env bundle, and a worker that booted, ran the setup script, and
finished clean.

## (Optional) Wire up the MCP server

So Claude Code sessions in the deploy dir can dispatch via the AI surface, add
this to `.mcp.json` (or `~/.claude/settings.json` for global):

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
including `ANTHROPIC_API_KEY` and any `DOCKER_HOST` you set for cross-machine
dispatch. Reload Claude Code; you should see nine `agora_*` tools — the dispatch
verbs (`agora_dispatch`, `agora_dispatch_describe`, `agora_dispatch_cancel`), the
registry reads (`agora_capabilities_list`, `agora_subagents_list`,
`agora_envs_list`), and the orchestrator verbs (`agora_orchestrator_submit`,
`agora_orchestrator_status`, `agora_orchestrator_watch`). The privileged
`register` / `assign` operations are deliberately absent — see
[The privilege boundary](/agora/explanation/privilege-boundary/).

## Next steps

- [Architecture overview](/agora/explanation/architecture-overview/) — the
  design behind the provider seams you just wired, if you want to read the
  model before going further.
- [Your first offload run](/agora/tutorials/first-offload-run/) — graduate from
  one dispatch to a whole DAG of tasks fanning out under file-locks, with a
  verifiable audit bundle at the end.
