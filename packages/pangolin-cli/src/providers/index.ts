// Provider registry. Maps `--provider <name>` to a SyncProvider implementation.
//
// Adding a provider is a single import + entry in PROVIDERS. The cmd-* files
// never reach for ClaudeCodeProvider directly — they resolve via this map so
// the surface stays uniform across providers.

import { ClaudeCodeProvider } from './claude-code.js';
import { StoaProvider } from './stoa.js';
import type { SyncProvider } from './types.js';

const PROVIDERS: ReadonlyMap<string, SyncProvider> = new Map<string, SyncProvider>([
  ['claude-code', new ClaudeCodeProvider()],
  ['stoa', new StoaProvider()],
]);

export function resolveProvider(name: string): SyncProvider {
  const provider = PROVIDERS.get(name);
  if (!provider) {
    const known = [...PROVIDERS.keys()].join(', ');
    throw new Error(`unknown --provider '${name}' (known: ${known})`);
  }
  return provider;
}

export function listProviderNames(): string[] {
  return [...PROVIDERS.keys()];
}

export type { SyncProvider, SubagentDef, CapabilityBundle } from './types.js';
