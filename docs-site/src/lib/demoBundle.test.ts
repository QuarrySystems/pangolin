import { describe, it, expect } from 'vitest';
import { PRISTINE_ITEMS, TAMPERS, BUNDLES, bundleById } from './demoBundle';
import { topoOrder, sealHonest, deriveReport, applyTamper, type DemoState } from './sealVerify';

describe('demoBundle (generic back-compat exports)', () => {
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

describe('BUNDLES registry', () => {
  it('has unique bundle ids and the generic bundle first', () => {
    const ids = BUNDLES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(BUNDLES[0]!.id).toBe('change-order');
  });
  it('bundleById resolves a known id and falls back to the default', () => {
    expect(bundleById('claims-appeal').id).toBe('claims-appeal');
    expect(bundleById('does-not-exist').id).toBe('change-order');
  });

  for (const b of BUNDLES) {
    describe(b.id, () => {
      it('is a valid acyclic fork→merge plan', () => {
        expect(() => topoOrder(b.items)).not.toThrow();
        expect(b.items.length).toBeGreaterThanOrEqual(4);
        // genuinely forks: some node has 2+ parents (the merge), and 2+ nodes share a parent
        const merges = b.items.filter((i) => i.parents.length >= 2);
        expect(merges.length).toBeGreaterThanOrEqual(1);
      });

      it('seals honestly: clean bundle is intact on both tiers', async () => {
        const sealed = await sealHonest(b.items);
        for (const tier of ['local', 's3-worm'] as const) {
          const r = await deriveReport({ sealed, tier, timeAttested: false });
          expect(r.intact).toBe(true);
        }
      });

      it('every tamper targets a real item, a tamperable field, and actually changes it', () => {
        const byId = new Map(b.items.map((i) => [i.id, i]));
        for (const t of b.tampers) {
          const target = byId.get(t.target);
          expect(target, `tamper ${t.id} targets missing item ${t.target}`).toBeDefined();
          expect(['outputPayload', 'scope']).toContain(t.field);
          // the preset must DIFFER from the sealed value, or the demo silently no-ops
          expect(t.value, `tamper ${t.id} does not change ${t.field}`).not.toBe(target![t.field]);
        }
      });

      it('every tamper breaks verification (chain fail, not intact)', async () => {
        for (const t of b.tampers) {
          const sealed = await sealHonest(b.items);
          const state: DemoState = {
            sealed: { ...sealed, items: applyTamper(sealed.items, t.target, t.field, t.value) },
            tier: 's3-worm',
            timeAttested: false,
          };
          const r = await deriveReport(state);
          expect(r.intact, `tamper ${t.id} left the bundle intact`).toBe(false);
          expect(r.failure).toBe('chain');
        }
      });
    });
  }
});
