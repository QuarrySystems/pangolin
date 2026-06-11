#!/usr/bin/env node
// check-mcp-tool-allowlist.mjs — load-bearing architectural enforcement of
// §7.7 / §10.6 of the pangolin-scale-mvp spec and ADR-005 (privileged-ops-never-ai-reachable).
//
// Imports `PANGOLIN_TOOL_NAMES` and `PANGOLIN_TOOL_METHODS` from the BUILT
// `@quarry-systems/pangolin-mcp` package (dist/) and `PRIVILEGE` from the BUILT
// `@quarry-systems/pangolin-orchestrator` package (dist/) — not the source — so
// this script exercises what consumers actually install.
//
// Checks:
//   1. Exposed run-time tool set equals exactly the nine documented names, in
//      declaration order (no surprise additions).
//   2. No name matches any forbidden pattern (`pangolin_*_register`,
//      `pangolin_*_assign`) that would imply a privileged deploy-time operation
//      has leaked onto the MCP surface.
//   3. §10.6 privilege intersection: no MCP-registered orchestrator tool maps
//      to a non-mcp-eligible method (privileged, service, or audit-only).
//
// Exit codes:
//   0  tool set matches, no forbidden patterns, §10.6 clean
//   1  mismatch, forbidden pattern, or §10.6 violation; clear error to stderr
//   1  dist/ missing (with `pnpm build` hint)
//
// Run from the pangolin-scale repo root: `node scripts/check-mcp-tool-allowlist.mjs`.
// Import `computeLeaks` from this module without triggering process.exit.

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Returns an array of human-readable leak messages: any MCP tool whose mapped
 * operations-API method is NOT mcp-eligible (i.e. privileged, service, or audit).
 *
 * @param {string[]} toolNames - list of MCP tool names
 * @param {Record<string,string>} toolMethods - map from tool name to operations-API method name
 * @param {Record<string,{tag:string,mcp:boolean}>} privilege - PRIVILEGE registry
 * @returns {string[]}
 */
export function computeLeaks(toolNames, toolMethods, privilege) {
  const leaks = [];
  for (const tool of toolNames) {
    const method = toolMethods[tool];
    if (!method) continue; // non-orch tool (e.g. pangolin_dispatch) — governed by forbidden-pattern check, not the privilege map
    const policy = privilege[method];
    if (!policy || policy.mcp !== true) {
      leaks.push(
        `${tool} → ${method} (${policy ? policy.tag : 'unknown'}) is NOT mcp-eligible — §10.6 forbids privileged/service/audit on MCP`,
      );
    }
  }
  return leaks;
}

async function main() {
  const MCP_DIST_ENTRY = resolve(
    __dirname,
    '..',
    'packages',
    'pangolin-mcp',
    'dist',
    'index.js',
  );

  if (!existsSync(MCP_DIST_ENTRY)) {
    console.error('✗ MCP tool allowlist check FAILED:');
    console.error(
      `  pangolin-mcp build artifact not found at ${MCP_DIST_ENTRY}.`,
    );
    console.error(
      '  Build the package first: `pnpm -F @quarry-systems/pangolin-mcp build`',
    );
    console.error('  (This script intentionally checks the BUILT output, not src/.)');
    process.exit(1);
  }

  const ORCH_DIST_ENTRY = resolve(
    __dirname,
    '..',
    'packages',
    'pangolin-orchestrator',
    'dist',
    'index.js',
  );

  if (!existsSync(ORCH_DIST_ENTRY)) {
    console.error('✗ MCP tool allowlist check FAILED:');
    console.error(
      `  pangolin-orchestrator build artifact not found at ${ORCH_DIST_ENTRY}.`,
    );
    console.error(
      '  Build the package first: `pnpm -F @quarry-systems/pangolin-orchestrator build`',
    );
    console.error('  (This script intentionally checks the BUILT output, not src/.)');
    process.exit(1);
  }

  const EXPECTED = [
    'pangolin_dispatch',
    'pangolin_dispatch_describe',
    'pangolin_dispatch_cancel',
    'pangolin_capabilities_list',
    'pangolin_subagents_list',
    'pangolin_envs_list',
    'pangolin_orchestrator_submit',
    'pangolin_orchestrator_status',
    'pangolin_orchestrator_watch',
  ];

  const FORBIDDEN_PATTERNS = [/^pangolin_.*_register$/, /^pangolin_.*_assign$/];

  const mcpMod = await import(pathToFileURL(MCP_DIST_ENTRY).href);
  const { PANGOLIN_TOOL_NAMES, PANGOLIN_TOOL_METHODS } = mcpMod;

  if (!Array.isArray(PANGOLIN_TOOL_NAMES)) {
    console.error('✗ MCP tool allowlist check FAILED:');
    console.error(
      '  Built pangolin-mcp package does not export PANGOLIN_TOOL_NAMES as an array.',
    );
    console.error('  See spec §7.7 and ADR-005 (privileged-ops-never-ai-reachable).');
    process.exit(1);
  }

  if (!PANGOLIN_TOOL_METHODS || typeof PANGOLIN_TOOL_METHODS !== 'object') {
    console.error('✗ MCP tool allowlist check FAILED:');
    console.error(
      '  Built pangolin-mcp package does not export PANGOLIN_TOOL_METHODS as an object.',
    );
    console.error('  See spec §10.6.');
    process.exit(1);
  }

  const orchMod = await import(pathToFileURL(ORCH_DIST_ENTRY).href);
  const { PRIVILEGE } = orchMod;

  if (!PRIVILEGE || typeof PRIVILEGE !== 'object') {
    console.error('✗ MCP tool allowlist check FAILED:');
    console.error(
      '  Built pangolin-orchestrator package does not export PRIVILEGE as an object.',
    );
    console.error('  See spec §10.6.');
    process.exit(1);
  }

  const actual = [...PANGOLIN_TOOL_NAMES];
  const errors = [];

  if (
    actual.length !== EXPECTED.length ||
    !actual.every((n, i) => n === EXPECTED[i])
  ) {
    errors.push(
      `pangolin-mcp tool set mismatch.\n    expected: ${JSON.stringify(EXPECTED)}\n    actual:   ${JSON.stringify(actual)}`,
    );
  }

  for (const name of actual) {
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(name)) {
        errors.push(
          `pangolin-mcp tool "${name}" matches forbidden pattern ${pattern}. ` +
            '§7.7: privileged operations are never reachable through the MCP tool surface.',
        );
      }
    }
  }

  if (errors.length > 0) {
    console.error('✗ MCP tool allowlist check FAILED:');
    for (const e of errors) console.error('  ' + e);
    console.error('');
    console.error(
      'See spec §7.7 and ADR-005 (privileged-ops-never-ai-reachable) for the rationale.',
    );
    process.exit(1);
  }

  // §10.6 privilege intersection check
  const leaks = computeLeaks(actual, PANGOLIN_TOOL_METHODS, PRIVILEGE);
  if (leaks.length > 0) {
    console.error('✗ MCP tool allowlist check FAILED (§10.6 privilege gate):');
    for (const leak of leaks) console.error('  ' + leak);
    console.error('');
    console.error(
      'See spec §10.6: privileged/service/audit methods must NEVER be reachable via MCP.',
    );
    process.exit(1);
  }

  console.log(
    `✓ pangolin-mcp exposes exactly the ${EXPECTED.length} documented run-time tools and no forbidden patterns.`,
  );
  console.log(
    `✓ §10.6 privilege check passed — all ${Object.keys(PANGOLIN_TOOL_METHODS).length} orch tool method mappings are mcp-eligible.`,
  );
}

// Only run the process-exiting main logic when invoked directly (not imported).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
