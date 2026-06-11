// check-mcp-tool-allowlist.test.mjs — unit tests for the §10.6 privilege gate.
//
// Run as: `node --test scripts/check-mcp-tool-allowlist.test.mjs`
// Uses the built-in `node:test` runner (no extra dependency).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLeaks } from './check-mcp-tool-allowlist.mjs';

test('passes for the shipped client-only orch surface', () => {
  assert.deepEqual(
    computeLeaks(['pangolin_orchestrator_submit'], { pangolin_orchestrator_submit: 'submit' }, { submit: { tag: 'client', mcp: true } }),
    [],
  );
});
test('FAILS when a privileged method (cancel) is wired to MCP', () => {
  const leaks = computeLeaks(['pangolin_orchestrator_cancel'], { pangolin_orchestrator_cancel: 'cancel' }, { cancel: { tag: 'privileged', mcp: false } });
  assert.equal(leaks.length, 1);
});
test('FAILS when audit (client but CLI-only) is wired to MCP', () => {
  const leaks = computeLeaks(['pangolin_orchestrator_audit'], { pangolin_orchestrator_audit: 'audit' }, { audit: { tag: 'client', mcp: false } });
  assert.equal(leaks.length, 1);
});
test('FAILS when a service method (serve) is wired to MCP', () => {
  const leaks = computeLeaks(['pangolin_orchestrator_serve'], { pangolin_orchestrator_serve: 'serve' }, { serve: { tag: 'service', mcp: false } });
  assert.equal(leaks.length, 1);
});
test('ignores non-orch tools with no method mapping (e.g. pangolin_dispatch)', () => {
  assert.deepEqual(computeLeaks(['pangolin_dispatch'], {}, {}), []);
});
