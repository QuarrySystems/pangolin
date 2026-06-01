// Architectural enforcement of §7.7 / ADR-005: the MCP run-time tool surface
// is exactly the nine documented tools — no register/assign privileged
// operations, no surprise additions. The CI script
// `scripts/check-mcp-tool-allowlist.mjs` mirrors this check against the BUILT
// package; this test fails locally during `pnpm -F @quarry-systems/agora-mcp
// test` so the rule is enforced at multiple layers.

import { AGORA_TOOL_NAMES } from '../src/tools.js';
import { it, expect } from 'vitest';

it('exposes exactly the nine run-time tools (six original + three orch)', () => {
  expect([...AGORA_TOOL_NAMES]).toEqual([
    'agora_dispatch',
    'agora_dispatch_describe',
    'agora_dispatch_cancel',
    'agora_capabilities_list',
    'agora_subagents_list',
    'agora_envs_list',
    'agora_orchestrator_submit',
    'agora_orchestrator_status',
    'agora_orchestrator_watch',
  ]);
});

it('exposes no tool matching agora_*_register pattern (§7.7)', () => {
  for (const name of AGORA_TOOL_NAMES) {
    expect(name).not.toMatch(/^agora_.*_register$/);
  }
});

it('exposes no tool matching agora_*_assign pattern (§7.7)', () => {
  for (const name of AGORA_TOOL_NAMES) {
    expect(name).not.toMatch(/^agora_.*_assign$/);
  }
});

it('exposes no orch tool matching the privileged/service names (cancel|audit|serve)', () => {
  for (const name of AGORA_TOOL_NAMES) {
    expect(name).not.toMatch(/^agora_orchestrator_(cancel|audit|serve)$/);
  }
});
