import { describe, it, expect } from 'vitest';
import * as orch from '../src/index.js';
import type { Schedule, ScheduleStore } from '../src/index.js';

describe('package entry — scheduling surface', () => {
  it('exposes the new scheduling runtime symbols', () => {
    expect(typeof orch.CronScheduler).toBe('function');
    expect(typeof orch.nextDueAfter).toBe('function');
    expect(typeof orch.SqliteScheduleStore).toBe('function');
  });
  it('keeps Schedule and ScheduleStore types importable from the entry', () => {
    // type-only usage compiles → contracts still flow through the barrel
    const _s: Schedule | undefined = undefined;
    const _st: ScheduleStore | undefined = undefined;
    expect(_s).toBeUndefined(); expect(_st).toBeUndefined();
  });
});
