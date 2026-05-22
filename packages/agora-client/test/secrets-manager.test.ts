import { describe, it, expect, vi } from 'vitest';
import {
  computeInlineSecretTtl,
  InlineSecretStager,
} from '../src/secrets-manager.js';

describe('computeInlineSecretTtl', () => {
  it('auto-computes TTL per §7.6 formula (default dispatch timeout)', () => {
    // Default formula: (7200 ?? dispatch.timeoutSeconds) + 300 = 7500
    expect(computeInlineSecretTtl({})).toBe(7500);
  });

  it('auto-computes TTL with provided dispatchTimeoutSeconds', () => {
    expect(computeInlineSecretTtl({ dispatchTimeoutSeconds: 600 })).toBe(900);
  });

  it('returns explicit ttlSeconds when provided, overriding auto-computed value', () => {
    expect(computeInlineSecretTtl({ explicit: 60 })).toBe(60);
  });

  it('explicit value of 0 is respected (not falsy-coerced)', () => {
    expect(computeInlineSecretTtl({ explicit: 0 })).toBe(0);
  });

  it('explicit value takes precedence even with dispatchTimeoutSeconds set', () => {
    expect(
      computeInlineSecretTtl({ explicit: 45, dispatchTimeoutSeconds: 600 }),
    ).toBe(45);
  });
});

describe('InlineSecretStager.stage', () => {
  it('uses namePrefix/dispatchId/envName as the secret name', async () => {
    const sends: any[] = [];
    const fakeClient: any = {
      send: vi.fn(async (cmd: any) => {
        sends.push({ name: cmd.constructor.name, input: cmd.input });
        return { ARN: 'arn:aws:secretsmanager:us-east-1:123:secret:abc' };
      }),
    };
    const stager = new InlineSecretStager({ client: fakeClient });
    await stager.stage({
      dispatchId: 'd1',
      envName: 'GH_TOKEN',
      inline: { inline: 's3cret' },
    });
    expect(sends).toHaveLength(1);
    expect(sends[0].name).toBe('CreateSecretCommand');
    expect(sends[0].input.Name).toBe('agora/inline/d1/GH_TOKEN');
  });

  it('honors custom namePrefix', async () => {
    const sends: any[] = [];
    const fakeClient: any = {
      send: vi.fn(async (cmd: any) => {
        sends.push(cmd.input);
        return { ARN: 'arn:secret' };
      }),
    };
    const stager = new InlineSecretStager({
      client: fakeClient,
      namePrefix: 'custom/prefix',
    });
    await stager.stage({
      dispatchId: 'd1',
      envName: 'TOKEN',
      inline: { inline: 's' },
    });
    expect(sends[0].Name).toBe('custom/prefix/d1/TOKEN');
  });

  it('sends inline value as SecretString', async () => {
    const sends: any[] = [];
    const fakeClient: any = {
      send: vi.fn(async (cmd: any) => {
        sends.push(cmd.input);
        return { ARN: 'arn:secret' };
      }),
    };
    const stager = new InlineSecretStager({ client: fakeClient });
    await stager.stage({
      dispatchId: 'd1',
      envName: 'GH_TOKEN',
      inline: { inline: 'super-secret-value' },
    });
    expect(sends[0].SecretString).toBe('super-secret-value');
  });

  it('tags the secret with agora:dispatchId and agora:ttlSeconds', async () => {
    const sends: any[] = [];
    const fakeClient: any = {
      send: vi.fn(async (cmd: any) => {
        sends.push(cmd.input);
        return { ARN: 'arn:secret' };
      }),
    };
    const stager = new InlineSecretStager({ client: fakeClient });
    await stager.stage({
      dispatchId: 'd1',
      envName: 'GH_TOKEN',
      inline: { inline: 's3cret' },
      dispatchTimeoutSeconds: 600,
    });
    expect(sends[0].Tags).toContainEqual({
      Key: 'agora:dispatchId',
      Value: 'd1',
    });
    expect(sends[0].Tags).toContainEqual({
      Key: 'agora:ttlSeconds',
      Value: '900',
    });
  });

  it('returns the ARN and ttlSeconds from stage()', async () => {
    const fakeClient: any = {
      send: vi.fn(async () => ({
        ARN: 'arn:aws:secretsmanager:us-east-1:123:secret:foo',
      })),
    };
    const stager = new InlineSecretStager({ client: fakeClient });
    const result = await stager.stage({
      dispatchId: 'd1',
      envName: 'GH_TOKEN',
      inline: { inline: 's3cret', ttlSeconds: 120 },
    });
    expect(result.arn).toBe(
      'arn:aws:secretsmanager:us-east-1:123:secret:foo',
    );
    expect(result.ttlSeconds).toBe(120);
  });

  it('throws when CreateSecret returns no ARN', async () => {
    const fakeClient: any = {
      send: vi.fn(async () => ({})),
    };
    const stager = new InlineSecretStager({ client: fakeClient });
    await expect(
      stager.stage({
        dispatchId: 'd1',
        envName: 'GH_TOKEN',
        inline: { inline: 's3cret' },
      }),
    ).rejects.toThrow(/no ARN/);
  });
});

describe('InlineSecretStager.cleanup', () => {
  it('lists secrets filtered by agora:dispatchId tag and deletes each with ForceDeleteWithoutRecovery', async () => {
    const calls: { name: string; input: any }[] = [];
    const fakeClient: any = {
      send: vi.fn(async (cmd: any) => {
        calls.push({ name: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === 'ListSecretsCommand') {
          return {
            SecretList: [
              { ARN: 'arn:secret:1', Name: 'agora/inline/d1/A' },
              { ARN: 'arn:secret:2', Name: 'agora/inline/d1/B' },
            ],
          };
        }
        return {};
      }),
    };
    const stager = new InlineSecretStager({ client: fakeClient });
    await stager.cleanup('d1');

    const list = calls.find((c) => c.name === 'ListSecretsCommand');
    expect(list).toBeDefined();
    expect(list!.input.Filters).toContainEqual({
      Key: 'tag-key',
      Values: ['agora:dispatchId'],
    });
    expect(list!.input.Filters).toContainEqual({
      Key: 'tag-value',
      Values: ['d1'],
    });

    const deletes = calls.filter((c) => c.name === 'DeleteSecretCommand');
    expect(deletes).toHaveLength(2);
    for (const d of deletes) {
      expect(d.input.ForceDeleteWithoutRecovery).toBe(true);
    }
    expect(deletes.map((d) => d.input.SecretId).sort()).toEqual([
      'arn:secret:1',
      'arn:secret:2',
    ]);
  });

  it('paginates through ListSecrets via NextToken', async () => {
    const calls: { name: string; input: any }[] = [];
    let listCallCount = 0;
    const fakeClient: any = {
      send: vi.fn(async (cmd: any) => {
        calls.push({ name: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === 'ListSecretsCommand') {
          listCallCount++;
          if (listCallCount === 1) {
            return {
              SecretList: [{ ARN: 'arn:secret:1' }],
              NextToken: 'page2',
            };
          }
          return { SecretList: [{ ARN: 'arn:secret:2' }] };
        }
        return {};
      }),
    };
    const stager = new InlineSecretStager({ client: fakeClient });
    await stager.cleanup('d1');

    const listCalls = calls.filter((c) => c.name === 'ListSecretsCommand');
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1].input.NextToken).toBe('page2');

    const deletes = calls.filter((c) => c.name === 'DeleteSecretCommand');
    expect(deletes).toHaveLength(2);
  });

  it('skips entries without an ARN', async () => {
    const calls: { name: string; input: any }[] = [];
    const fakeClient: any = {
      send: vi.fn(async (cmd: any) => {
        calls.push({ name: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === 'ListSecretsCommand') {
          return {
            SecretList: [
              { ARN: 'arn:secret:1' },
              { Name: 'no-arn-entry' },
            ],
          };
        }
        return {};
      }),
    };
    const stager = new InlineSecretStager({ client: fakeClient });
    await stager.cleanup('d1');
    const deletes = calls.filter((c) => c.name === 'DeleteSecretCommand');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].input.SecretId).toBe('arn:secret:1');
  });
});
