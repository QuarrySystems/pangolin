// Provider registry internals: the built-in map, shape validation for
// config-supplied providers, the merge, and the two resolution entry points.
//
// Two resolution shapes exist on purpose:
//
//   - `resolveProvider(name, extra, source)` — eager. The caller already has
//     the config in hand (it loaded it for other reasons), so validating the
//     whole `syncProviders` array costs nothing.
//
//   - `resolveProviderLazily(name, getExtra)` — lazy. The caller would have to
//     import `pangolin.config.*` just to answer `--provider claude-code`. A
//     built-in name short-circuits before `getExtra` is ever called, so a
//     missing or broken config cannot break the built-in providers.
//
// `PROVIDERS` is never mutated: `mergeProviders` copies it, so a bad config in
// one command cannot leak a half-registered provider into the next.

import { ClaudeCodeProvider } from './claude-code.js';
import { StoaProvider } from './stoa.js';
import type { SyncProvider } from './types.js';

/** The raw `syncProviders` export plus the config filename it came from. */
export interface ConfigProviders {
  /** Unvalidated — including "not an array". The array check is mergeProviders'. */
  providers: unknown;
  /** The config filename that actually resolved, e.g. 'pangolin.config.js'. */
  source: string;
}

const PROVIDERS: ReadonlyMap<string, SyncProvider> = new Map<string, SyncProvider>([
  ['claude-code', new ClaudeCodeProvider()],
  ['stoa', new StoaProvider()],
]);

export function findBuiltIn(name: string): SyncProvider | undefined {
  return PROVIDERS.get(name);
}

export function listProviderNames(): string[] {
  return [...PROVIDERS.keys()];
}

/** Module-private on purpose: a second entry point would reopen a validation bypass. */
function validateEntry(value: unknown, index: number, source: string): SyncProvider {
  const fail = (why: string): never => {
    throw new Error(`${source}: syncProviders[${index}] ${why}`);
  };
  if (typeof value !== 'object' || value === null) return fail('is not an object');
  const p = value as Record<string, unknown>;
  if (typeof p.name !== 'string' || p.name.length === 0)
    return fail('has no non-empty string `name`');
  for (const m of ['loadSubagents', 'loadCapabilities']) {
    if (typeof p[m] !== 'function') return fail(`has no \`${m}\` function`);
  }
  for (const d of ['defaultSubagentDir', 'defaultCapabilityDir']) {
    if (typeof p[d] !== 'string') return fail(`has no \`${d}\` string`);
  }
  return value as SyncProvider;
}

export function mergeProviders(extra: unknown, source: string): ReadonlyMap<string, SyncProvider> {
  if (!Array.isArray(extra)) {
    throw new Error(
      `${source}: syncProviders must be an array (got ${extra === null ? 'null' : typeof extra})`,
    );
  }
  const merged = new Map(PROVIDERS);
  const seen = new Set<string>();
  extra.forEach((raw, i) => {
    const p = validateEntry(raw, i, source);
    if (PROVIDERS.has(p.name)) {
      throw new Error(
        `${source}: syncProviders[${i}] name '${p.name}' collides with a built-in provider`,
      );
    }
    if (seen.has(p.name)) {
      throw new Error(`${source}: syncProviders[${i}] duplicate name '${p.name}'`);
    }
    seen.add(p.name);
    merged.set(p.name, p);
  });
  return merged;
}

export function resolveProvider(name: string, extra: unknown, source: string): SyncProvider {
  const merged = mergeProviders(extra, source);
  const provider = merged.get(name);
  if (!provider) {
    throw new Error(`unknown --provider '${name}' (known: ${[...merged.keys()].join(', ')})`);
  }
  return provider;
}

export async function resolveProviderLazily(
  name: string,
  getExtra: () => Promise<ConfigProviders | null>,
): Promise<SyncProvider> {
  const builtIn = findBuiltIn(name);
  if (builtIn) return builtIn;
  const config = await getExtra();
  if (!config) {
    throw new Error(`unknown --provider '${name}' (known: ${listProviderNames().join(', ')})`);
  }
  return resolveProvider(name, config.providers, config.source);
}
