import { describe, it, expect } from 'vitest';
import { AgoraClient } from '../src/client.js';

const fakeStorage: any = { name: 'fake' };
const fakeCompute: any = { name: 'fake-compute' };
const fakeCreds: any = { name: 'fake-creds' };

describe('AgoraClient', () => {
  it('rejects targets that reference unknown compute providers', () => {
    expect(
      () =>
        new AgoraClient({
          namespace: 'my-org',
          compute: { fargate: fakeCompute },
          credentials: { aws: fakeCreds },
          storage: fakeStorage,
          targets: { prod: { compute: 'nonexistent', credentials: 'aws' } },
        }),
    ).toThrow(/unknown compute/);
  });

  it('rejects targets that reference unknown credential providers', () => {
    expect(
      () =>
        new AgoraClient({
          namespace: 'my-org',
          compute: { fargate: fakeCompute },
          credentials: { aws: fakeCreds },
          storage: fakeStorage,
          targets: { prod: { compute: 'fargate', credentials: 'nonexistent' } },
        }),
    ).toThrow(/unknown credentials/);
  });

  it('enforces the 7-year retention cap', () => {
    expect(
      () =>
        new AgoraClient({
          namespace: 'my-org',
          compute: {},
          credentials: {},
          storage: fakeStorage,
          targets: {},
          dispatchRetention: { maxDays: 99999 },
        }),
    ).toThrow(/7-year/);
  });

  it('rejects dispatchRetention.defaultDays greater than maxDays', () => {
    expect(
      () =>
        new AgoraClient({
          namespace: 'my-org',
          compute: {},
          credentials: {},
          storage: fakeStorage,
          targets: {},
          dispatchRetention: { defaultDays: 60, maxDays: 30 },
        }),
    ).toThrow(/defaultDays/);
  });

  it('requires namespace', () => {
    expect(
      () =>
        new AgoraClient({
          // @ts-expect-error – intentionally missing namespace
          namespace: '',
          compute: {},
          credentials: {},
          storage: fakeStorage,
          targets: {},
        }),
    ).toThrow(/namespace/);
  });

  it('requires storage', () => {
    expect(
      () =>
        new AgoraClient({
          namespace: 'my-org',
          compute: {},
          credentials: {},
          // @ts-expect-error – intentionally missing storage
          storage: undefined,
          targets: {},
        }),
    ).toThrow(/storage/);
  });

  it('exposes the provided options as readonly fields', () => {
    const client = new AgoraClient({
      namespace: 'my-org',
      compute: { fargate: fakeCompute },
      credentials: { aws: fakeCreds },
      storage: fakeStorage,
      targets: { prod: { compute: 'fargate', credentials: 'aws' } },
      defaultModel: 'sonnet',
    });
    expect(client.namespace).toBe('my-org');
    expect(client.storage).toBe(fakeStorage);
    expect(client.compute.fargate).toBe(fakeCompute);
    expect(client.credentials.aws).toBe(fakeCreds);
    expect(client.targets.prod.compute).toBe('fargate');
    expect(client.defaultModel).toBe('sonnet');
  });

  it('defaults retention to 30 / 2555 days when no config is supplied', () => {
    const client = new AgoraClient({
      namespace: 'my-org',
      compute: {},
      credentials: {},
      storage: fakeStorage,
      targets: {},
    });
    expect(client.retention.defaultDays).toBe(30);
    expect(client.retention.maxDays).toBe(2555);
  });
});
