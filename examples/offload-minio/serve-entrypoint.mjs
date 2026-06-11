// examples/offload-minio/serve-entrypoint.mjs
//
// Serve-container entrypoint.  Runs the orchestrator tick+inbox loop.
// This file is the CMD target for Dockerfile.serve (see examples/offload-minio/).
//
// No inbound port is opened — the serve container is the sole SQLite writer and
// the only caller of orchestrator.tick(); workers are launched as Docker siblings
// via the mounted socket (wired in docker-compose, not here).

import { serve } from '@quarry-systems/pangolin-orchestrator';
import { orch } from './pangolin.config.mjs';

const ac = new AbortController();
process.on('SIGTERM', () => ac.abort());
process.on('SIGINT',  () => ac.abort());

const orchestrator = orch.createOrchestrator();

console.log('[serve] starting tick+inbox loop (no inbound port)…');
await serve({ orchestrator, transport: orch.transport, signal: ac.signal });
console.log('[serve] stopped cleanly');
