#!/usr/bin/env node
// check-mcp-tool-allowlist.mjs — load-bearing architectural enforcement of
// §7.7 of the agora-mvp spec and ADR-005 (privileged-ops-never-ai-reachable).
//
// Imports `AGORA_TOOL_NAMES` from the BUILT `@quarry-systems/agora-mcp`
// package (dist/) — not the source — so this script exercises what consumers
// actually install. Asserts the exposed run-time tool set equals exactly the
// six documented names, in declaration order, AND that no name matches any
// forbidden pattern (`agora_*_register`, `agora_*_assign`) that would imply
// a privileged deploy-time operation has leaked onto the MCP surface.
//
// Exit codes:
//   0  tool set matches and no forbidden patterns
//   1  mismatch or forbidden pattern; clear error printed to stderr
//   1  dist/ missing (with `pnpm build` hint)
//
// Run from the agora repo root: `node scripts/check-mcp-tool-allowlist.mjs`.

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DIST_ENTRY = resolve(
  __dirname,
  '..',
  'packages',
  'agora-mcp',
  'dist',
  'index.js',
);

if (!existsSync(DIST_ENTRY)) {
  console.error('✗ MCP tool allowlist check FAILED:');
  console.error(
    `  agora-mcp build artifact not found at ${DIST_ENTRY}.`,
  );
  console.error(
    '  Build the package first: `pnpm -F @quarry-systems/agora-mcp build`',
  );
  console.error('  (This script intentionally checks the BUILT output, not src/.)');
  process.exit(1);
}

const EXPECTED = [
  'agora_dispatch',
  'agora_dispatch_describe',
  'agora_dispatch_cancel',
  'agora_capabilities_list',
  'agora_subagents_list',
  'agora_envs_list',
];

const FORBIDDEN_PATTERNS = [/^agora_.*_register$/, /^agora_.*_assign$/];

const mod = await import(pathToFileURL(DIST_ENTRY).href);
const { AGORA_TOOL_NAMES } = mod;

if (!Array.isArray(AGORA_TOOL_NAMES)) {
  console.error('✗ MCP tool allowlist check FAILED:');
  console.error(
    '  Built agora-mcp package does not export AGORA_TOOL_NAMES as an array.',
  );
  console.error('  See spec §7.7 and ADR-005 (privileged-ops-never-ai-reachable).');
  process.exit(1);
}

const actual = [...AGORA_TOOL_NAMES];
const errors = [];

if (
  actual.length !== EXPECTED.length ||
  !actual.every((n, i) => n === EXPECTED[i])
) {
  errors.push(
    `agora-mcp tool set mismatch.\n    expected: ${JSON.stringify(EXPECTED)}\n    actual:   ${JSON.stringify(actual)}`,
  );
}

for (const name of actual) {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(name)) {
      errors.push(
        `agora-mcp tool "${name}" matches forbidden pattern ${pattern}. ` +
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

console.log(
  `✓ agora-mcp exposes exactly the ${EXPECTED.length} documented run-time tools and no forbidden patterns.`,
);
