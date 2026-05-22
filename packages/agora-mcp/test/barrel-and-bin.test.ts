import { describe, it, expect } from 'vitest';

describe('agora-mcp barrel exports', () => {
  it('exports runServer', async () => {
    const mod = await import('../src/index.js');
    expect(mod.runServer).toBeDefined();
    expect(typeof mod.runServer).toBe('function');
  });

  it('exports RunServerOpts type', async () => {
    // RunServerOpts is a TypeScript interface re-exported from server.ts
    // Verify it's in the source code export statement
    const fs = await import('fs');
    const content = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf-8');
    expect(content).toContain('RunServerOpts');
  });

  it('exports AGORA_TOOL_NAMES', async () => {
    const mod = await import('../src/index.js');
    expect(mod.AGORA_TOOL_NAMES).toBeDefined();
    expect(Array.isArray(mod.AGORA_TOOL_NAMES)).toBe(true);
    expect(mod.AGORA_TOOL_NAMES).toEqual([
      'agora_dispatch',
      'agora_dispatch_describe',
      'agora_dispatch_cancel',
      'agora_capabilities_list',
      'agora_subagents_list',
      'agora_envs_list',
    ]);
  });

  it('exports registerAgoraTools', async () => {
    const mod = await import('../src/index.js');
    expect(mod.registerAgoraTools).toBeDefined();
    expect(typeof mod.registerAgoraTools).toBe('function');
  });
});

describe('agora-mcp bin entry', () => {
  it('bin.ts has a shebang', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync(new URL('../src/bin.ts', import.meta.url), 'utf-8');
    expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('bin.ts calls runServer', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync(new URL('../src/bin.ts', import.meta.url), 'utf-8');
    expect(content).toContain('runServer');
  });

  it('bin.ts resolves agora.config', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync(new URL('../src/bin.ts', import.meta.url), 'utf-8');
    expect(content).toContain('agora.config');
  });
});
