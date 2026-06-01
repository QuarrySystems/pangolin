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

  it('exports AGORA_TOOL_NAMES with nine tools (six original + three orch)', async () => {
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
      'agora_orchestrator_submit',
      'agora_orchestrator_status',
      'agora_orchestrator_watch',
    ]);
  });

  it('exports AGORA_TOOL_METHODS mapping orch tools to method names', async () => {
    const mod = await import('../src/index.js');
    expect(mod.AGORA_TOOL_METHODS).toBeDefined();
    expect(typeof mod.AGORA_TOOL_METHODS).toBe('object');
    expect(mod.AGORA_TOOL_METHODS).toEqual({
      agora_orchestrator_submit: 'submit',
      agora_orchestrator_status: 'status',
      agora_orchestrator_watch: 'watch',
    });
  });

  it('AGORA_TOOL_METHODS has no entry for cancel/audit/serve', async () => {
    const mod = await import('../src/index.js');
    const methods = mod.AGORA_TOOL_METHODS as Record<string, string>;
    expect(methods).not.toHaveProperty('agora_orchestrator_cancel');
    expect(methods).not.toHaveProperty('agora_orchestrator_audit');
    expect(methods).not.toHaveProperty('agora_orchestrator_serve');
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

  it('bin.ts handles optional orch export from config', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync(new URL('../src/bin.ts', import.meta.url), 'utf-8');
    // bin.ts should reference orch and OperationsApi
    expect(content).toContain('orch');
    expect(content).toContain('OperationsApi');
  });
});
