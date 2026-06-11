import { describe, it, expect } from 'vitest';

describe('pangolin-mcp barrel exports', () => {
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

  it('exports PANGOLIN_TOOL_NAMES with nine tools (six original + three orch)', async () => {
    const mod = await import('../src/index.js');
    expect(mod.PANGOLIN_TOOL_NAMES).toBeDefined();
    expect(Array.isArray(mod.PANGOLIN_TOOL_NAMES)).toBe(true);
    expect(mod.PANGOLIN_TOOL_NAMES).toEqual([
      'pangolin_dispatch',
      'pangolin_dispatch_describe',
      'pangolin_dispatch_cancel',
      'pangolin_capabilities_list',
      'pangolin_subagents_list',
      'pangolin_envs_list',
      'pangolin_orchestrator_submit',
      'pangolin_orchestrator_status',
      'pangolin_orchestrator_watch',
    ]);
  });

  it('exports PANGOLIN_TOOL_METHODS mapping orch tools to method names', async () => {
    const mod = await import('../src/index.js');
    expect(mod.PANGOLIN_TOOL_METHODS).toBeDefined();
    expect(typeof mod.PANGOLIN_TOOL_METHODS).toBe('object');
    expect(mod.PANGOLIN_TOOL_METHODS).toEqual({
      pangolin_orchestrator_submit: 'submit',
      pangolin_orchestrator_status: 'status',
      pangolin_orchestrator_watch: 'watch',
    });
  });

  it('PANGOLIN_TOOL_METHODS has no entry for cancel/audit/serve', async () => {
    const mod = await import('../src/index.js');
    const methods = mod.PANGOLIN_TOOL_METHODS as Record<string, string>;
    expect(methods).not.toHaveProperty('pangolin_orchestrator_cancel');
    expect(methods).not.toHaveProperty('pangolin_orchestrator_audit');
    expect(methods).not.toHaveProperty('pangolin_orchestrator_serve');
  });

  it('exports registerPangolinTools', async () => {
    const mod = await import('../src/index.js');
    expect(mod.registerPangolinTools).toBeDefined();
    expect(typeof mod.registerPangolinTools).toBe('function');
  });
});

describe('pangolin-mcp bin entry', () => {
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

  it('bin.ts resolves pangolin.config', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync(new URL('../src/bin.ts', import.meta.url), 'utf-8');
    expect(content).toContain('pangolin.config');
  });

  it('bin.ts handles optional orch export from config', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync(new URL('../src/bin.ts', import.meta.url), 'utf-8');
    // bin.ts should reference orch and OperationsApi
    expect(content).toContain('orch');
    expect(content).toContain('OperationsApi');
  });
});
