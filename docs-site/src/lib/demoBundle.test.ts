import { describe, it, expect } from 'vitest';
import { PRISTINE_ITEMS, TAMPERS } from './demoBundle';
import { topoOrder } from './sealVerify';

describe('demoBundle', () => {
  it('is a valid acyclic plan', () => {
    expect(() => topoOrder(PRISTINE_ITEMS)).not.toThrow();
    expect(PRISTINE_ITEMS.length).toBeGreaterThanOrEqual(4);
  });
  it('every tamper targets a real item and a tamperable field', () => {
    const ids = new Set(PRISTINE_ITEMS.map((i) => i.id));
    for (const t of TAMPERS) {
      expect(ids.has(t.target)).toBe(true);
      expect(['outputPayload', 'scope']).toContain(t.field);
    }
  });
});
