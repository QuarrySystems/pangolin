// Published SPI surface. This file is publicised at the `./providers`
// package subpath, so whatever is exported here becomes public API.
// Registry internals (PROVIDERS, resolveProvider, resolveProviderLazily,
// mergeProviders, findBuiltIn, listProviderNames) live in ./registry.js and
// are deliberately NOT re-exported here.

export type { SyncProvider, SubagentDef, CapabilityBundle } from './types.js';
export { ClaudeCodeProvider } from './claude-code.js';
export { StoaProvider } from './stoa.js';
export { splitFrontmatter } from '../frontmatter.js';
