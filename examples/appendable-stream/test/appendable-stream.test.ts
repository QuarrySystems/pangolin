import { describe, it, expect } from 'vitest';
import { runAppendableStream } from '../src/index.js';

describe('appendable-stream example', () => {
  it('pushes items into a patterned open-ended run, the pattern routes them, close seals an intact bundle', async () => {
    const { bundle, items } = await runAppendableStream();
    expect(bundle.report.intact).toBe(true);
    expect(items.every((i) => i.status === 'done' || i.status === 'skipped')).toBe(true);
    // 1 seed + 3 pushed (wave1-a, wave1-b, wave2-c) + 4 pattern-spawned followups = 8
    expect(items.length).toBeGreaterThanOrEqual(8);
  }, 30_000);
});
