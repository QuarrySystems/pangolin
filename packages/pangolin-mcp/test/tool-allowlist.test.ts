// Architectural enforcement of §7.7 / ADR-005: the MCP run-time tool surface
// is exactly the nine documented tools — no register/assign privileged
// operations, no surprise additions. The CI script
// `scripts/check-mcp-tool-allowlist.mjs` mirrors this check against the BUILT
// package; this test fails locally during `pnpm -F @quarry-systems/pangolin-mcp
// test` so the rule is enforced at multiple layers.

import { PANGOLIN_TOOL_NAMES } from '../src/tools.js';
import { it, expect } from 'vitest';

it('exposes exactly the nine run-time tools (six original + three orch)', () => {
  expect([...PANGOLIN_TOOL_NAMES]).toEqual([
    'pangolin_dispatch',
    'pangolin_dispatch_describe',
    'pangolin_dispatch_cancel',
    'pangolin_capabilities_list',
    'pangolin_subagents_list',
    'pangolin_envs_list',
    'pangolin_orchestrator_submit',
    'pangolin_orchestrator_status',
    'pangolin_orchestrator_watch',
  ]);
});

it('exposes no tool matching pangolin_*_register pattern (§7.7)', () => {
  for (const name of PANGOLIN_TOOL_NAMES) {
    expect(name).not.toMatch(/^pangolin_.*_register$/);
  }
});

it('exposes no tool matching pangolin_*_assign pattern (§7.7)', () => {
  for (const name of PANGOLIN_TOOL_NAMES) {
    expect(name).not.toMatch(/^pangolin_.*_assign$/);
  }
});

it('exposes no orch tool matching the privileged/service names (cancel|audit|serve)', () => {
  for (const name of PANGOLIN_TOOL_NAMES) {
    expect(name).not.toMatch(/^pangolin_orchestrator_(cancel|audit|serve)$/);
  }
});
