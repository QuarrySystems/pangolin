import { describe, it, expect } from 'vitest';
import { runAppendableStream } from '../src/index.js';

describe('appendable-stream example', () => {
  it('pushes items into a patterned open-ended run, the pattern routes them, close seals an intact bundle', async () => {
    const { bundle, items } = await runAppendableStream();
    expect(bundle.report.intact).toBe(true);
    expect(items.every((i) => i.status === 'done' || i.status === 'skipped')).toBe(true);
    // seed + appended waves + ≥1 pattern-spawned item
    expect(items.length).toBeGreaterThan(2);
  }, 30_000);
});
