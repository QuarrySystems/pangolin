import { attachEnvCmd, parseSecretArg, SecretArgParseError } from '../src/cmd-env.js';
import { Command } from 'commander';
import { it, expect, describe, vi, afterEach } from 'vitest';

describe('parseSecretArg', () => {
  // Contract: arn:* and local-secret://* → { ref }; inline:* → { inline } (prefix stripped);
  // anything else (bare value or unrecognised prefix) → throws SecretArgParseError.

  it('arn: prefix → { ref }', () => {
    expect(parseSecretArg('K=arn:aws:...:x')).toEqual({ K: { ref: 'arn:aws:...:x' } });
  });

  it('local-secret:// prefix → { ref }', () => {
    expect(parseSecretArg('K=local-secret://abc')).toEqual({ K: { ref: 'local-secret://abc' } });
  });

  it('inline: prefix → { inline } (strips prefix)', () => {
    expect(parseSecretArg('K=inline:mysecretvalue')).toEqual({ K: { inline: 'mysecretvalue' } });
  });

  it('handles values with = signs correctly', () => {
    expect(parseSecretArg('K=inline:val=with=equals')).toEqual({ K: { inline: 'val=with=equals' } });
  });

  it('bare value (no recognised prefix) → throws SecretArgParseError', () => {
    expect(() => parseSecretArg('K=plaintext')).toThrow(SecretArgParseError);
  });

  it('unrecognised prefix → throws SecretArgParseError with key name in message', () => {
    expect(() => parseSecretArg('BADSECRET=badprefix:value')).toThrow(SecretArgParseError);
    expect(() => parseSecretArg('BADSECRET=badprefix:value')).toThrow('BADSECRET');
  });
});

describe('attachEnvCmd', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('attachEnvCmd registers register/list/get subcommands', () => {
    const program = new Command();
    attachEnvCmd(program, { getClient: async () => ({} as any) });
    const env = program.commands.find(c => c.name() === 'env')!;
    expect(env.commands.map(c => c.name()).sort()).toEqual(['get', 'list', 'register']);
  });

  it('register command accepts repeated --value flags', async () => {
    const mockRegister = vi.fn().mockResolvedValue({
      name: 'myenv',
      contentHash: 'sha256:abc123',
      registeredAt: '2026-05-21T00:00:00Z',
    });
    const mockClient = {
      env: {
        register: mockRegister,
      },
    };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachEnvCmd(program, { getClient: async () => mockClient as any });

    await program.parseAsync([
      'node', 'agora',
      'env', 'register',
      '--name', 'myenv',
      '--value', 'KEY1=val1',
      '--value', 'KEY2=val2',
    ]);

    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'myenv',
        values: { KEY1: 'val1', KEY2: 'val2' },
      })
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('myenv')
    );
  });

  it('register command accepts repeated --secret flags with arn: prefix → { ref }', async () => {
    const mockRegister = vi.fn().mockResolvedValue({
      name: 'myenv',
      contentHash: 'sha256:abc123',
      registeredAt: '2026-05-21T00:00:00Z',
    });
    const mockClient = {
      env: {
        register: mockRegister,
      },
    };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachEnvCmd(program, { getClient: async () => mockClient as any });

    await program.parseAsync([
      'node', 'agora',
      'env', 'register',
      '--name', 'myenv',
      '--secret', 'DB_PASS=arn:aws:secretsmanager:us-east-1:123456789012:secret:mydb-pass',
    ]);

    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'myenv',
        secrets: {
          DB_PASS: {
            ref: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mydb-pass',
          },
        },
      })
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('myenv')
    );
  });

  it('register command accepts repeated --secret flags with local-secret:// prefix → { ref }', async () => {
    const mockRegister = vi.fn().mockResolvedValue({
      name: 'myenv',
      contentHash: 'sha256:abc123',
      registeredAt: '2026-05-21T00:00:00Z',
    });
    const mockClient = {
      env: {
        register: mockRegister,
      },
    };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachEnvCmd(program, { getClient: async () => mockClient as any });

    await program.parseAsync([
      'node', 'agora',
      'env', 'register',
      '--name', 'myenv',
      '--secret', 'MY_SECRET=local-secret://my-local-key',
    ]);

    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'myenv',
        secrets: {
          MY_SECRET: {
            ref: 'local-secret://my-local-key',
          },
        },
      })
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('myenv')
    );
  });

  it('register command accepts repeated --secret flags with inline: prefix', async () => {
    const mockRegister = vi.fn().mockResolvedValue({
      name: 'myenv',
      contentHash: 'sha256:abc123',
      registeredAt: '2026-05-21T00:00:00Z',
    });
    const mockClient = {
      env: {
        register: mockRegister,
      },
    };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachEnvCmd(program, { getClient: async () => mockClient as any });

    await program.parseAsync([
      'node', 'agora',
      'env', 'register',
      '--name', 'myenv',
      '--secret', 'SECRET=inline:mysecretvalue',
    ]);

    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'myenv',
        secrets: {
          SECRET: {
            inline: 'mysecretvalue',
          },
        },
      })
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('myenv')
    );
  });

  it('register command rejects unrecognized secret prefix', async () => {
    const mockClient = {
      env: {
        register: vi.fn(),
      },
    };
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    const program = new Command();
    attachEnvCmd(program, { getClient: async () => mockClient as any });

    await program.parseAsync([
      'node', 'agora',
      'env', 'register',
      '--name', 'myenv',
      '--secret', 'BADSECRET=badprefix:value',
    ]);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('BADSECRET')
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('list command prints one line per ref', async () => {
    const mockList = vi.fn().mockResolvedValue([
      { name: 'env1', contentHash: 'sha256:abc', registeredAt: '2026-05-21T00:00:00Z' },
      { name: 'env2', contentHash: 'sha256:def', registeredAt: '2026-05-21T00:01:00Z' },
    ]);
    const mockClient = {
      env: {
        list: mockList,
      },
    };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachEnvCmd(program, { getClient: async () => mockClient as any });

    await program.parseAsync([
      'node', 'agora',
      'env', 'list',
    ]);

    expect(mockList).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledTimes(2);
    expect(consoleSpy).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^env1\tsha256:abc\t2026-05-21T00:00:00Z$/)
    );
    expect(consoleSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^env2\tsha256:def\t2026-05-21T00:01:00Z$/)
    );
  });

  it('get command prints ref as JSON', async () => {
    const mockGet = vi.fn().mockResolvedValue({
      name: 'myenv',
      contentHash: 'sha256:abc123',
      registeredAt: '2026-05-21T00:00:00Z',
    });
    const mockClient = {
      env: {
        get: mockGet,
      },
    };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachEnvCmd(program, { getClient: async () => mockClient as any });

    await program.parseAsync([
      'node', 'agora',
      'env', 'get',
      'myenv',
    ]);

    expect(mockGet).toHaveBeenCalledWith('myenv');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^{"name":"myenv","contentHash":"sha256:abc123","registeredAt":"2026-05-21T00:00:00Z"}$/)
    );
  });

  it('get command prints (not found) when ref is null', async () => {
    const mockGet = vi.fn().mockResolvedValue(null);
    const mockClient = {
      env: {
        get: mockGet,
      },
    };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachEnvCmd(program, { getClient: async () => mockClient as any });

    await program.parseAsync([
      'node', 'agora',
      'env', 'get',
      'nonexistent',
    ]);

    expect(mockGet).toHaveBeenCalledWith('nonexistent');
    expect(consoleSpy).toHaveBeenCalledWith('(not found)');
  });

  it('register command handles values with = signs', async () => {
    const mockRegister = vi.fn().mockResolvedValue({
      name: 'myenv',
      contentHash: 'sha256:abc123',
      registeredAt: '2026-05-21T00:00:00Z',
    });
    const mockClient = {
      env: {
        register: mockRegister,
      },
    };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachEnvCmd(program, { getClient: async () => mockClient as any });

    await program.parseAsync([
      'node', 'agora',
      'env', 'register',
      '--name', 'myenv',
      '--value', 'QUERY=SELECT * FROM table WHERE id=1',
    ]);

    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'myenv',
        values: { QUERY: 'SELECT * FROM table WHERE id=1' },
      })
    );
  });

  it('register command combines --value and --secret in single call', async () => {
    const mockRegister = vi.fn().mockResolvedValue({
      name: 'myenv',
      contentHash: 'sha256:abc123',
      registeredAt: '2026-05-21T00:00:00Z',
    });
    const mockClient = {
      env: {
        register: mockRegister,
      },
    };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    attachEnvCmd(program, { getClient: async () => mockClient as any });

    await program.parseAsync([
      'node', 'agora',
      'env', 'register',
      '--name', 'myenv',
      '--value', 'LOG_LEVEL=debug',
      '--secret', 'DB_PASS=arn:aws:secretsmanager:us-east-1:123456789012:secret:mydb',
      '--secret', 'API_KEY=inline:secret123',
    ]);

    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'myenv',
        values: { LOG_LEVEL: 'debug' },
        secrets: {
          DB_PASS: { ref: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mydb' },
          API_KEY: { inline: 'secret123' },
        },
      })
    );
  });
});
