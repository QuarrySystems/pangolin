// deploy/serve-stack/serve-entrypoint.mjs
//
// Serve-container entrypoint.  Runs the orchestrator tick+inbox loop.
// This file is the CMD target for deploy/serve-stack/Dockerfile.
//
// No inbound port is opened — the serve container is the sole SQLite writer and
// the only caller of orchestrator.tick(); workers are launched as Docker siblings
// via the mounted socket (wired in docker-compose, not here).
//
// Cross-task interface contract (fulfilled by the sibling task-deploy-config):
//   agora.config.mjs (sibling file, NOT created here) MUST export:
//     - `orch.createOrchestrator()` — factory returning an Orchestrator instance
//     - `orch.transport`            — the mailbox transport (e.g. S3-backed)
//   This entrypoint also imports `serve` from @quarry-systems/agora-orchestrator.
//   All three must align for the serve loop to start.

import { serve } from '@quarry-systems/agora-orchestrator';
import { orch } from './agora.config.mjs';

const ac = new AbortController();
process.on('SIGTERM', () => ac.abort());
process.on('SIGINT',  () => ac.abort());

const orchestrator = orch.createOrchestrator();

console.log('[serve] starting tick+inbox loop (no inbound port)…');
await serve({ orchestrator, transport: orch.transport, signal: ac.signal });
console.log('[serve] stopped cleanly');
