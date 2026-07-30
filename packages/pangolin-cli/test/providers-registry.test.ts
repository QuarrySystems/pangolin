// Provider registry: built-in map, config-provider shape validation, merge,
// and the two resolution entry points (eager + lazy).
//
// The lazy path is the one with teeth: `resolveProviderLazily` must NOT
// consult the config loader when the requested name is a built-in, because
// the loader is what imports `pangolin.config.*` — reaching for it on the
// happy path would make `--provider claude-code` fail in a repo with a
// broken/absent config. That negative is asserted with a fake that throws
// if called, and paired with a positive companion so it cannot pass on a
// no-op implementation.

import { describe, it, expect, vi } from 'vitest';
import * as registry from '../src/providers/registry.js';
import {
  findBuiltIn,
  listProviderNames,
  mergeProviders,
  resolveProvider,
  resolveProviderLazily,
} from '../src/providers/registry.js';
import type { SyncProvider } from '../src/providers/types.js';

/** A minimally-valid config-supplied provider. */
function fakeProvider(name: string): SyncProvider {
  return {
    name,
    defaultSubagentDir: `.${name}/agents`,
    defaultCapabilityDir: `.${name}/skills`,
    loadSubagents: async () => [],
    loadCapabilities: async () => [],
  };
}

describe('findBuiltIn / listProviderNames', () => {
  it('returns the built-in providers by name', () => {
    expect(findBuiltIn('claude-code')).toMatchObject({ name: 'claude-code' });
    expect(findBuiltIn('stoa')).toMatchObject({ name: 'stoa' });
  });

  it('returns undefined for a name that is not built in', () => {
    expect(findBuiltIn('remora')).toBeUndefined();
  });

  it('lists the built-in names in insertion order', () => {
    expect(listProviderNames()).toEqual(['claude-code', 'stoa']);
  });
});

describe('mergeProviders — non-array input', () => {
  it('throws naming the config file when given null', () => {
    expect(() => mergeProviders(null, 'pangolin.config.mjs')).toThrow(
      /^pangolin\.config\.mjs: syncProviders must be an array \(got null\)$/,
    );
  });

  it('throws when given undefined (not special-cased here — the loader normalizes)', () => {
    expect(() => mergeProviders(undefined, 'pangolin.config.ts')).toThrow(
      /^pangolin\.config\.ts: syncProviders must be an array \(got undefined\)$/,
    );
  });

  it('throws when given a non-array object', () => {
    expect(() => mergeProviders({ 'claude-code': {} }, 'pangolin.config.js')).toThrow(
      /^pangolin\.config\.js: syncProviders must be an array \(got object\)$/,
    );
  });

  it('throws when given a string', () => {
    expect(() => mergeProviders('remora', 'pangolin.config.js')).toThrow(
      /^pangolin\.config\.js: syncProviders must be an array \(got string\)$/,
    );
  });
});

describe('mergeProviders — entry shape validation', () => {
  it('names the real resolved config file, not a hardcoded .mjs', () => {
    expect(() => mergeProviders([{ name: 'remora' }], 'pangolin.config.js')).toThrow(
      /pangolin\.config\.js: syncProviders\[0\] has no `loadSubagents` function/,
    );
  });

  it('rejects a null entry', () => {
    expect(() => mergeProviders([null], 'pangolin.config.mjs')).toThrow(
      'pangolin.config.mjs: syncProviders[0] is not an object',
    );
  });

  it('rejects a non-object entry', () => {
    expect(() => mergeProviders(['remora'], 'pangolin.config.mjs')).toThrow(
      'pangolin.config.mjs: syncProviders[0] is not an object',
    );
  });

  it('rejects an entry with no `name`', () => {
    const { name: _drop, ...rest } = fakeProvider('remora');
    expect(() => mergeProviders([rest], 'pangolin.config.mjs')).toThrow(
      'pangolin.config.mjs: syncProviders[0] has no non-empty string `name`',
    );
  });

  it('rejects an entry with an empty-string `name`', () => {
    expect(() => mergeProviders([{ ...fakeProvider('remora'), name: '' }], 'p.config.js')).toThrow(
      'p.config.js: syncProviders[0] has no non-empty string `name`',
    );
  });

  it('rejects an entry with a non-string `name`', () => {
    expect(() => mergeProviders([{ ...fakeProvider('remora'), name: 7 }], 'p.config.js')).toThrow(
      'p.config.js: syncProviders[0] has no non-empty string `name`',
    );
  });

  it.each(['loadSubagents', 'loadCapabilities'])('rejects an entry missing %s', (method) => {
    const entry: Record<string, unknown> = { ...fakeProvider('remora') };
    delete entry[method];
    expect(() => mergeProviders([entry], 'pangolin.config.mjs')).toThrow(
      `pangolin.config.mjs: syncProviders[0] has no \`${method}\` function`,
    );
  });

  it.each(['loadSubagents', 'loadCapabilities'])(
    'rejects an entry whose %s is not a function',
    (method) => {
      const entry: Record<string, unknown> = { ...fakeProvider('remora'), [method]: 'nope' };
      expect(() => mergeProviders([entry], 'pangolin.config.mjs')).toThrow(
        `pangolin.config.mjs: syncProviders[0] has no \`${method}\` function`,
      );
    },
  );

  it.each(['defaultSubagentDir', 'defaultCapabilityDir'])(
    'rejects an entry missing %s',
    (dirField) => {
      const entry: Record<string, unknown> = { ...fakeProvider('remora') };
      delete entry[dirField];
      expect(() => mergeProviders([entry], 'pangolin.config.mjs')).toThrow(
        `pangolin.config.mjs: syncProviders[0] has no \`${dirField}\` string`,
      );
    },
  );

  it.each(['defaultSubagentDir', 'defaultCapabilityDir'])(
    'rejects an entry whose %s is not a string',
    (dirField) => {
      const entry: Record<string, unknown> = { ...fakeProvider('remora'), [dirField]: 42 };
      expect(() => mergeProviders([entry], 'pangolin.config.mjs')).toThrow(
        `pangolin.config.mjs: syncProviders[0] has no \`${dirField}\` string`,
      );
    },
  );

  it('reports the offending index, not always 0', () => {
    expect(() =>
      mergeProviders([fakeProvider('remora'), { name: 'kraken' }], 'pangolin.config.mjs'),
    ).toThrow(/pangolin\.config\.mjs: syncProviders\[1\] has no `loadSubagents` function/);
  });
});

describe('mergeProviders — name conflicts', () => {
  it('rejects a config entry colliding with a built-in', () => {
    expect(() => mergeProviders([fakeProvider('claude-code')], 'pangolin.config.mjs')).toThrow(
      "pangolin.config.mjs: syncProviders[0] name 'claude-code' collides with a built-in provider",
    );
  });

  it('names the index of the colliding entry', () => {
    expect(() =>
      mergeProviders([fakeProvider('remora'), fakeProvider('stoa')], 'pangolin.config.js'),
    ).toThrow("pangolin.config.js: syncProviders[1] name 'stoa' collides with a built-in provider");
  });

  it('rejects two config entries sharing a name', () => {
    expect(() =>
      mergeProviders([fakeProvider('remora'), fakeProvider('remora')], 'pangolin.config.mjs'),
    ).toThrow("pangolin.config.mjs: syncProviders[1] duplicate name 'remora'");
  });
});

describe('mergeProviders — success', () => {
  it('returns built-ins plus config providers, built-ins first', () => {
    const merged = mergeProviders([fakeProvider('remora')], 'pangolin.config.mjs');
    expect([...merged.keys()]).toEqual(['claude-code', 'stoa', 'remora']);
    expect(merged.get('remora')).toMatchObject({ name: 'remora' });
  });

  it('accepts an empty array', () => {
    expect([...mergeProviders([], 'pangolin.config.mjs').keys()]).toEqual(['claude-code', 'stoa']);
  });

  it('does not mutate the built-in map', () => {
    mergeProviders([fakeProvider('remora')], 'pangolin.config.mjs');
    expect(findBuiltIn('remora')).toBeUndefined();
    expect(listProviderNames()).toEqual(['claude-code', 'stoa']);
  });
});

describe('resolveProvider', () => {
  it('resolves a built-in', () => {
    expect(resolveProvider('stoa', [], 'pangolin.config.mjs')).toMatchObject({ name: 'stoa' });
  });

  it('resolves a config-supplied provider', () => {
    const remora = fakeProvider('remora');
    expect(resolveProvider('remora', [remora], 'pangolin.config.mjs')).toBe(remora);
  });

  it('lists built-ins first then config names in insertion order on an unknown name', () => {
    expect(() =>
      resolveProvider(
        'nope',
        [fakeProvider('remora'), fakeProvider('kraken')],
        'pangolin.config.js',
      ),
    ).toThrow("unknown --provider 'nope' (known: claude-code, stoa, remora, kraken)");
  });

  it('propagates validation failures rather than reporting an unknown name', () => {
    expect(() => resolveProvider('remora', [{ name: 'remora' }], 'pangolin.config.mjs')).toThrow(
      /syncProviders\[0\] has no `loadSubagents` function/,
    );
  });
});

describe('resolveProviderLazily', () => {
  it('does not consult the config when the name is a built-in', async () => {
    const getExtra = vi.fn(async () => {
      throw new Error('must not be called');
    });
    await expect(resolveProviderLazily('claude-code', getExtra)).resolves.toMatchObject({
      name: 'claude-code',
    });
    expect(getExtra).not.toHaveBeenCalled();
  });

  it('consults the config and resolves a config-supplied provider', async () => {
    const remora = fakeProvider('remora');
    const getExtra = vi.fn(async () => ({
      providers: [remora],
      source: 'pangolin.config.js',
    }));
    await expect(resolveProviderLazily('remora', getExtra)).resolves.toBe(remora);
    expect(getExtra).toHaveBeenCalledTimes(1);
  });

  it('lists only the built-ins when there is no config at all', async () => {
    const getExtra = vi.fn(async () => null);
    await expect(resolveProviderLazily('remora', getExtra)).rejects.toThrow(
      "unknown --provider 'remora' (known: claude-code, stoa)",
    );
    expect(getExtra).toHaveBeenCalledTimes(1);
  });

  it('lists config names too when a config exists but lacks the name', async () => {
    const getExtra = vi.fn(async () => ({
      providers: [fakeProvider('kraken')],
      source: 'pangolin.config.mjs',
    }));
    await expect(resolveProviderLazily('remora', getExtra)).rejects.toThrow(
      "unknown --provider 'remora' (known: claude-code, stoa, kraken)",
    );
  });

  it('surfaces the config validation error, naming the resolved config file', async () => {
    const getExtra = vi.fn(async () => ({
      providers: [{ name: 'remora' }],
      source: 'pangolin.config.js',
    }));
    await expect(resolveProviderLazily('remora', getExtra)).rejects.toThrow(
      /pangolin\.config\.js: syncProviders\[0\] has no `loadSubagents` function/,
    );
  });
});

describe('module surface', () => {
  it('does not export the shape validator', () => {
    expect(Object.keys(registry).sort()).toEqual([
      'findBuiltIn',
      'listProviderNames',
      'mergeProviders',
      'resolveProvider',
      'resolveProviderLazily',
    ]);
  });
});
