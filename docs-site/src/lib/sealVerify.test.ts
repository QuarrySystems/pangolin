import { describe, it, expect } from 'vitest';
import { sha256Hex, ownString, topoOrder, sealBundle, type DemoItem } from './sealVerify';
import { claimFor } from '@quarry-systems/pangolin-core'; // REAL rule (Node test env → Buffer ok)
import {
  sealHonest, deriveReport, reseal, applyTamper, nodeStatuses, claimFor as mirroredClaimFor,
  type DemoState,
} from './sealVerify';

const items: DemoItem[] = [
  { id: 'd0', label: 'Ingest', executor: 'dispatch', action: 'intent.ingest', parents: [],
    inputPayload: 'raw', outputPayload: 'structured', scope: 'read:intake', secretRef: 'tok_a' },
  { id: 'd1', label: 'Price', executor: 'dispatch', action: 'compute.cost', parents: ['d0'],
    inputPayload: 'lines', outputPayload: 'cost=5', scope: 'read:rates', secretRef: 'tok_b' },
  { id: 'd2', label: 'Emit', executor: 'dispatch', action: 'emit.amend', parents: ['d1'],
    inputPayload: 'pkt', outputPayload: 'amend.pdf', scope: 'write:amend', secretRef: 'tok_c' },
];

describe('sha256Hex', () => {
  it('is the real SHA-256 of the input', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('topoOrder', () => {
  it('orders parents before children', () => {
    const order = topoOrder(items);
    expect(order.indexOf('d0')).toBeLessThan(order.indexOf('d1'));
    expect(order.indexOf('d1')).toBeLessThan(order.indexOf('d2'));
  });
  it('throws on a cycle', () => {
    const cyclic: DemoItem[] = [
      { ...items[0], id: 'a', parents: ['b'] },
      { ...items[1], id: 'b', parents: ['a'] },
    ];
    expect(() => topoOrder(cyclic)).toThrow(/cycle/);
  });
});

describe('sealBundle', () => {
  it('is deterministic for identical input', async () => {
    const a = await sealBundle(items);
    const b = await sealBundle(items);
    expect(a.root).toBe(b.root);
  });
  it('changes the root when any own-field changes', async () => {
    const a = await sealBundle(items);
    const mutated = items.map((i) => (i.id === 'd1' ? { ...i, outputPayload: 'cost=999' } : i));
    const b = await sealBundle(mutated);
    expect(b.root).not.toBe(a.root);
  });
});

async function freshState(tier: DemoState['tier']): Promise<DemoState> {
  return { sealed: await sealHonest(items), tier, timeAttested: false };
}

describe('deriveReport — clean bundle', () => {
  it('local → tamper-detecting, signature n/a, intact', async () => {
    const r = await deriveReport(await freshState('local'));
    expect(r.intact).toBe(true);
    expect(r.claim).toBe('tamper-detecting');
    expect(r.checks.signature.ok).toBe('n/a');
    expect(r.guarantee).toBe('detect');
  });
  it('s3-worm → tamper-evident, signature true', async () => {
    const r = await deriveReport(await freshState('s3-worm'));
    expect(r.claim).toBe('tamper-evident');
    expect(r.checks.signature.ok).toBe(true);
    expect(r.guarantee).toBe('external-immutable');
  });
  it('time axis is orthogonal — attesting time never changes the tamper claim', async () => {
    const s = { ...(await freshState('s3-worm')), timeAttested: true };
    const r = await deriveReport(s);
    expect(r.claim).toBe('tamper-evident');
    expect(r.timeTier).toBe('tsa-attested');
  });
  it('rank gate: a signed WORM bundle flipped to local downgrades by RANK, not signature', async () => {
    const worm = await freshState('s3-worm');
    const local = { ...worm, tier: 'local' as const };
    expect((await deriveReport(local)).claim).toBe('tamper-detecting');
  });
});

describe('deriveReport — tamper + reseal', () => {
  it('tamper without reseal → not intact, failure chain', async () => {
    const s = await freshState('s3-worm');
    s.sealed.items = applyTamper(s.sealed.items, 'd1', 'outputPayload', 'cost=99999');
    const r = await deriveReport(s);
    expect(r.intact).toBe(false);
    expect(r.failure).toBe('chain');
  });
  it('local: attacker reseal succeeds (intact, tamper-detecting)', async () => {
    let s = await freshState('local');
    s.sealed.items = applyTamper(s.sealed.items, 'd1', 'outputPayload', 'cost=99999');
    s = await reseal(s);
    const r = await deriveReport(s);
    expect(r.intact).toBe(true);
    expect(r.claim).toBe('tamper-detecting');
  });
  it('s3-worm: attacker reseal caught with root-mismatch', async () => {
    let s = await freshState('s3-worm');
    s.sealed.items = applyTamper(s.sealed.items, 'd1', 'outputPayload', 'cost=99999');
    s = await reseal(s);
    const r = await deriveReport(s);
    expect(r.intact).toBe(false);
    expect(r.failure).toBe('root-mismatch');
  });
});

describe('nodeStatuses — ripple', () => {
  it('tampering a parent marks it tampered and descendants broken', async () => {
    const s = await freshState('local');
    s.sealed.items = applyTamper(s.sealed.items, 'd1', 'outputPayload', 'cost=99999');
    const st = await nodeStatuses(s);
    expect(st.d0).toBe('verified');
    expect(st.d1).toBe('tampered');
    expect(st.d2).toBe('broken');
  });
});

describe('claimFor parity guard', () => {
  it('mirrored rule matches the real pangolin-core claimFor for all combos', () => {
    const guarantees = ['detect', 'external-immutable', 'witnessed'] as const;
    const sigs = [true, false, 'n/a'] as const;
    for (const intact of [true, false])
      for (const g of guarantees)
        for (const sig of sigs)
          expect(mirroredClaimFor(intact, g, sig)).toBe(claimFor(intact, g, sig));
  });
});
