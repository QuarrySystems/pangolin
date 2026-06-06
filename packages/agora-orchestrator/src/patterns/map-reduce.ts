import type { Pattern, MapReduceConfig } from '../contracts/pattern.js';

/** Sorted for determinism — spawn order and reduce key order are stable across replays. */
const sortedKeys = (o: Record<string, unknown>) => Object.keys(o).sort();

/** Validate that a MapReduceConfig is well-formed; throws a descriptive Error if not. */
function assertMapReduceConfig(cfg: unknown): void {
  if (cfg === null || typeof cfg !== 'object') {
    throw new Error('map-reduce: mapReduce config must be a non-null object');
  }
  const c = cfg as Record<string, unknown>;

  // Validate map template
  if (c['map'] === null || typeof c['map'] !== 'object') {
    throw new Error('map-reduce: mapReduce.map template is required and must be an object');
  }
  const map = c['map'] as Record<string, unknown>;
  if (typeof map['executor'] !== 'string') {
    throw new Error('map-reduce: mapReduce.map.executor is required and must be a string');
  }
  if (map['inputs'] === null || typeof map['inputs'] !== 'object') {
    throw new Error('map-reduce: mapReduce.map.inputs is required and must be an object');
  }

  // Validate reduce template
  if (c['reduce'] === null || typeof c['reduce'] !== 'object') {
    throw new Error('map-reduce: mapReduce.reduce template is required and must be an object');
  }
  const reduce = c['reduce'] as Record<string, unknown>;
  if (typeof reduce['executor'] !== 'string') {
    throw new Error('map-reduce: mapReduce.reduce.executor is required and must be a string');
  }
  if (reduce['inputs'] === null || typeof reduce['inputs'] !== 'object') {
    throw new Error('map-reduce: mapReduce.reduce.inputs is required and must be an object');
  }
}

export const mapReduce: Pattern = {
  id: 'map-reduce',

  plan: (run) => {
    const splitters = run.items.filter((i) => i.inputs['mapReduce'] !== undefined);
    if (splitters.length > 1) {
      throw new Error(`map-reduce: at most one splitter per run, found ${splitters.length}`);
    }
    if (splitters.length === 1) {
      assertMapReduceConfig(splitters[0]!.inputs['mapReduce']);
    }
    return run;
  },

  onTaskDone: (item, ctx) => {
    if (item.status === 'cancelled') return null;

    const splitter = ctx.runItems.find((i) => i.inputs['mapReduce'] !== undefined);
    if (!splitter || splitter.status !== 'done') return null;

    const cfg = splitter.inputs['mapReduce'] as MapReduceConfig;
    const keys = sortedKeys(splitter.outputRefs ?? {});
    if (keys.length === 0) return null;

    // Phase 1 — cause is the splitter: spawn map-<key> per output (id-skip absorbs replays).
    if (item.id === splitter.id) {
      return {
        items: keys.map((k) => ({
          id: `map-${k}`,
          executor: cfg.map.executor,
          inputs: cfg.map.inputs,
          ...(cfg.map.subagentShape ? { subagentShape: cfg.map.subagentShape } : {}),
          depends_on: [],
          resourceLocks: cfg.map.resourceLocks ?? [],
          needs: {
            [cfg.map.needsKey ?? 'input']: {
              from: splitter.id,
              select: { kind: 'output' as const, path: k },
            },
          },
        })),
      };
    }

    // Phase 2 — cause is a map: when ALL maps are done and no reduce exists, spawn it.
    const mapIds = new Set(keys.map((k) => `map-${k}`));
    if (!mapIds.has(item.id)) return null;
    const byId = new Map(ctx.runItems.map((i) => [i.id, i]));
    if (byId.has('reduce')) return null;
    if (!keys.every((k) => byId.get(`map-${k}`)?.status === 'done')) return null;

    const prefix = cfg.reduce.keyPrefix ?? 'part';
    return {
      items: [{
        id: 'reduce',
        executor: cfg.reduce.executor,
        inputs: cfg.reduce.inputs,
        ...(cfg.reduce.subagentShape ? { subagentShape: cfg.reduce.subagentShape } : {}),
        depends_on: [],
        resourceLocks: cfg.reduce.resourceLocks ?? [],
        needs: Object.fromEntries(
          keys.map((k) => [
            `${prefix}-${k}`,
            {
              from: `map-${k}`,
              select: { kind: 'output' as const, path: cfg.map.outputPath ?? 'result' },
            },
          ]),
        ),
      }],
    };
  },
};
