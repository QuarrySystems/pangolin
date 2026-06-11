// packages/pangolin-orchestrator/test/barrel-pattern-surface.test.ts
// Verifies that the pattern layer symbols are reachable from the package root.
import { describe, it, expect } from 'vitest';
import { staticDag, pipeline, mapReduce, collectSpawns, respawnLineage, parseAttempt } from '../src/index.js';
import type { Pattern, GateConfig, MapReduceConfig, CollectedSpawn } from '../src/index.js';

describe('package entry — pattern layer surface', () => {
  it('exposes staticDag, pipeline, mapReduce as objects', () => {
    expect(typeof staticDag).toBe('object');
    expect(typeof pipeline).toBe('object');
    expect(typeof mapReduce).toBe('object');
  });

  it('exposes collectSpawns, respawnLineage, parseAttempt as functions', () => {
    expect(typeof collectSpawns).toBe('function');
    expect(typeof respawnLineage).toBe('function');
    expect(typeof parseAttempt).toBe('function');
  });

  it('keeps Pattern, GateConfig, MapReduceConfig, CollectedSpawn types importable from the entry', () => {
    // type-only usage compiles → contracts still flow through the barrel
    const _p: Pattern | undefined = undefined;
    const _g: GateConfig | undefined = undefined;
    const _m: MapReduceConfig | undefined = undefined;
    const _c: CollectedSpawn | undefined = undefined;
    expect(_p).toBeUndefined();
    expect(_g).toBeUndefined();
    expect(_m).toBeUndefined();
    expect(_c).toBeUndefined();
  });
});
