import { AwsCredentialProvider } from '../src/index.js';
import { it, expect } from 'vitest';

it('resolves credentials via the injected provider override', async () => {
  const provider = new AwsCredentialProvider({
    providerOverride: async () => ({ accessKeyId: 'AKIA-test', secretAccessKey: 'secret-test' }),
  });
  const resolved = await provider.resolve();
  expect(resolved.kind).toBe('aws');
  expect(resolved.accessKeyId).toBe('AKIA-test');
  expect(resolved.secretAccessKey).toBe('secret-test');
});

it('exposes name === "aws"', () => {
  const provider = new AwsCredentialProvider({
    providerOverride: async () => ({ accessKeyId: 'AKIA', secretAccessKey: 'sk' }),
  });
  expect(provider.name).toBe('aws');
});

it('propagates sessionToken when present on the underlying credentials', async () => {
  const provider = new AwsCredentialProvider({
    providerOverride: async () => ({
      accessKeyId: 'AKIA-test',
      secretAccessKey: 'secret-test',
      sessionToken: 'session-test',
    }),
  });
  const resolved = await provider.resolve();
  expect(resolved.sessionToken).toBe('session-test');
});

it('propagates errors thrown by the underlying credential provider', async () => {
  const boom = new Error('credential chain failed');
  const provider = new AwsCredentialProvider({
    providerOverride: async () => {
      throw boom;
    },
  });
  await expect(provider.resolve()).rejects.toThrow('credential chain failed');
});
