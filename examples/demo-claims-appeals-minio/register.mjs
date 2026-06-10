// register.mjs — out-of-process registration step for the host-serve CLI flow.
//
// Registers all shared storage artifacts before `pangolin orch serve` starts:
//   - appeal-kit capability (pangolin-setup.sh + 3 claim fixtures)
//   - claim-appeal subagent (model pinned, promptTemplate, verify)
//   - verify subagent (post-fan-out DAG gate)
//   - minimal env
//
// Claim-path consistency: fixture keys match plan.json's workerInput.claim paths
// exactly (fixture/claims/claim-00N.json) so the worker overlay materialises them
// at that workspace path. The overlay engine mkdir -p's parent dirs automatically.
//
// Run: node register.mjs
// (Requires PANGOLIN_S3_ENDPOINT / PANGOLIN_S3_ACCESS_KEY / PANGOLIN_S3_SECRET_KEY
//  or defaults to MinIO at localhost:9000 with minioadmin:minioadmin credentials.)

import client from './pangolin.config.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Seed the 3 claim fixtures at the SAME keys plan.json's workerInput.claim uses,
// so the worker materialises them at fixture/claims/claim-00N.json.
// The overlay engine (packages/pangolin-worker/src/overlay-engine.ts:81) does
// mkdir(dirname(fullPath), { recursive: true }), so nested keys are safe.
const claimKeys = [
  'fixture/claims/claim-001.json',
  'fixture/claims/claim-002.json',
  'fixture/claims/claim-003.json',
];

const claimFiles = Object.fromEntries(
  await Promise.all(
    claimKeys.map(async (k) => [k, await readFile(join(here, k), 'utf8')]),
  ),
);

// 1. Capability: setup script + claim fixtures.
await client.capabilities.register({
  name: 'appeal-kit',
  files: { 'pangolin-setup.sh': '#!/bin/sh\nmkdir -p appeals\n', ...claimFiles },
});

// 2. Drafting subagent. model pinned so Beat 3 renders a non-empty model id.
//    promptTemplate (NOT systemPrompt) so {{claim}} is Mustache-substituted with
//    the per-item dispatch input. `verify` is the Gap-A self-verify.
//    Prompt lifted verbatim from examples/demo-claims-appeals/src/index.ts.
await client.subagent.register({
  name: 'claim-appeal',
  model: 'claude-haiku-4-5-20251001',
  capabilities: ['appeal-kit'],
  promptTemplate: [
    'You are working in your workspace (the current directory). A JSON file',
    '`{{claim}}` in the workspace root describes a denied insurance claim with',
    'fields: claimId, claimant, service, denialReason, policySection, supportingFacts.',
    'Read it. Then write a formal appeal letter to `appeals/<claimId>.md` (use the',
    'claimId value verbatim) containing, in order:',
    '  1. The claimant name and claim id.',
    '  2. A paragraph directly rebutting denialReason, grounded in supportingFacts.',
    '  3. A citation of policySection.',
    'Create ONLY that one file. Change nothing else. Then stop.',
  ].join('\n'),
  verify: {
    // language-agnostic; report-only; sealed with the patch (Beat 3).
    command: 'ls appeals/*.md >/dev/null 2>&1 && grep -q "§" appeals/*.md',
    timeout: 60,
  },
});

// 3. DAG gate subagent. Runs after all three appeals reach done.
//    systemPrompt lifted verbatim from examples/demo-claims-appeals/src/index.ts.
await client.subagent.register({
  name: 'verify',
  capabilities: ['appeal-kit'],
  systemPrompt:
    'You are the post-fan-out gate for a claims-appeal batch. It runs after all ' +
    'appeal items have completed. Confirm your workspace contains the claim JSON ' +
    'files, then exit 0.',
});

// 4. Minimal env — LOG_LEVEL only; no secrets staged here (the serve-side
//    executor stages ANTHROPIC_API_KEY per-dispatch).
await client.env.register({
  name: 'minimal',
  values: { LOG_LEVEL: 'info' },
});

console.log('registered: claim-appeal (model pinned), verify, appeal-kit, minimal');
