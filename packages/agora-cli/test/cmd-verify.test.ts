import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  AuditBundle,
  AuditAnchor,
  AuditAnchorReceipt,
  AuditEntryRow,
  AnchoredRoot,
} from '@quarry-systems/agora-orchestrator';
import type { SubmissionTransport, ControlChannel } from '@quarry-systems/agora-orchestrator';
import type { OrchContext } from '../src/cmd-orch.js';
import { attachVerifyCmd } from '../src/cmd-verify.js';
import type { CliContext } from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers mirrored from verify-bundle.test.ts
// ---------------------------------------------------------------------------

/** Build a fake AuditAnchor that serves exactly one AnchoredRoot. */
function anchorOf(root: Uint8Array, guarantee: 'detect' | 'external-immutable' | 'witnessed' = 'external-immutable'): AuditAnchor {
  return {
    id: 'fake',
    guarantee,
    async anchor() {
      return { anchorId: 'fake', epochId: 'r', guarantee, at: 0 };
    },
    async fetch(range?: { epochId?: string }) {
      const epochId = range?.epochId ?? 'r';
      return [{ epochId, root, receipt: { anchorId: 'fake', epochId, guarantee, at: 0 } }];
    },
  };
}

/** Build a pair of chained AuditEntryRows and compute their merkle root. */
async function buildEntries(runId: string): Promise<{ entries: AuditEntryRow[]; root: Uint8Array }> {
  // Import internals for constructing test fixtures
  const { canonEntry } = await import('@quarry-systems/agora-orchestrator/src/audit/canon.js');
  const { chainHash, merkleRoot, leavesFromEntryHashes } = await import('@quarry-systems/agora-orchestrator/src/audit/merkle.js');

  const mk = (e: Omit<AuditEntryRow, 'entryHash' | 'prevHash' | 'runId'>, prev: string): AuditEntryRow => {
    const entry = { ...e, runId };
    const eh = chainHash(canonEntry(entry), prev);
    return { ...entry, entryHash: eh, prevHash: prev };
  };

  const e0 = mk({ seq: 0, kind: 'run.submitted', at: 't0' }, '');
  const e1 = mk({ seq: 1, kind: 'run.completed', at: 't1' }, e0.entryHash);
  const root = merkleRoot(leavesFromEntryHashes([e0.entryHash, e1.entryHash]));
  return { entries: [e0, e1], root };
}

/** Build a sealed AuditBundle with correct chain + merkle root. */
async function buildSealedBundle(runId: string = 'r'): Promise<{ bundle: AuditBundle; root: Uint8Array }> {
  const { entries, root } = await buildEntries(runId);
  const anchoredRoot: AnchoredRoot = {
    epochId: runId,
    root,
    receipt: { anchorId: 'fake', epochId: runId, guarantee: 'external-immutable', at: 0 },
  };
  const bundle: AuditBundle = {
    runId,
    manifests: [],
    auditLog: { entries, root: anchoredRoot },
    items: [],
    report: {
      runId,
      anchorId: 'fake',
      guarantee: 'external-immutable',
      intact: true,
      claim: 'tamper-evident',
      checks: {
        chain: { ok: true },
        root: { ok: true },
        signature: { ok: 'n/a' },
        anchor: { ok: true },
      },
    },
  };
  return { bundle, root };
}

/** Serialize an AuditBundle to JSON, converting any Uint8Arrays to base64. */
function serializeBundle(bundle: AuditBundle): string {
  return JSON.stringify(bundle, (_key, value) => {
    // Uint8Array doesn't survive JSON.stringify by default — it becomes {}
    // The verifyBundle/verify pipeline re-fetches the root from anchor.fetch(),
    // so we only need the entries to survive intact. The anchoredRoot.root is
    // only needed by the anchor fetch path, not by bundle deserialization.
    if (value instanceof Uint8Array) {
      return { __uint8array__: true, data: Array.from(value) };
    }
    return value;
  });
}

// ---------------------------------------------------------------------------
// Minimal fake transport (needed by OrchContext)
// ---------------------------------------------------------------------------

function makeFakeTransport(): SubmissionTransport & ControlChannel {
  return {
    async submit(env: any) { return env.run.id; },
    async pollInbox() { return []; },
    async ack(_runId: string) {},
    async deadLetter(_runId: string) {},
    async publish(_rec: any) {},
    async readOutbox(_runId: string) { return []; },
    async control(_env: any) {},
    async pollControl() { return []; },
    async ackControl(_target: string) {},
  };
}

function makeCtx(oc: OrchContext): CliContext {
  return {
    getClient: async () => ({} as any),
    getOrchContext: async () => oc,
  };
}

// ---------------------------------------------------------------------------
// Capture console.log output during a parseAsync call
// ---------------------------------------------------------------------------

import { vi } from 'vitest';

async function captureLog(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const originalLog = console.log;
  const prevExitCode = process.exitCode;
  process.exitCode = undefined;

  console.log = vi.fn((...args: unknown[]) => logs.push(args.map(String).join(' ')));
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  const code = process.exitCode as number | undefined;
  // restore
  process.exitCode = prevExitCode;
  return { logs, exitCode: code };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('attachVerifyCmd', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agora-cli-verify-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('registers verify as a top-level command visible in program commands', () => {
    const program = new Command();
    const transport = makeFakeTransport();
    const oc: OrchContext = { transport, anchor: anchorOf(new Uint8Array(32)) };
    const ctx = makeCtx(oc);
    attachVerifyCmd(program, ctx);

    const verifyCmd = program.commands.find((c) => c.name() === 'verify');
    expect(verifyCmd).toBeDefined();
    // Should be top-level, not nested
    expect(program.commands.map((c) => c.name())).toContain('verify');
  });

  it('prints TAMPER-EVIDENT and exits 0 for a clean exported bundle', async () => {
    const { bundle, root } = await buildSealedBundle('run-clean-1');
    const bundlePath = join(tmpDir, 'clean-bundle.json');
    await writeFile(bundlePath, serializeBundle(bundle));

    const oc: OrchContext = {
      transport: makeFakeTransport(),
      anchor: anchorOf(root, 'external-immutable'),
    };
    const ctx = makeCtx(oc);
    const program = new Command();
    attachVerifyCmd(program, ctx);

    const { logs, exitCode } = await captureLog(() =>
      program.parseAsync(['verify', bundlePath], { from: 'user' }),
    );

    const output = logs.join('\n');
    expect(output).toContain('TAMPER-EVIDENT');
    expect(exitCode).not.toBe(1);
  });

  it('prints TAMPERED and exits 1 for an altered bundle', async () => {
    const { bundle, root } = await buildSealedBundle('run-tampered-1');

    // Mutate an entry after the fact so chain hash no longer matches
    bundle.auditLog.entries[0]!.actor = 'attacker';

    const bundlePath = join(tmpDir, 'tampered-bundle.json');
    await writeFile(bundlePath, serializeBundle(bundle));

    // Anchor still holds the original (pre-tamper) root
    const oc: OrchContext = {
      transport: makeFakeTransport(),
      anchor: anchorOf(root, 'external-immutable'),
    };
    const ctx = makeCtx(oc);
    const program = new Command();
    attachVerifyCmd(program, ctx);

    // captureLog already saves and restores process.exitCode around the call.
    const { logs, exitCode } = await captureLog(() =>
      program.parseAsync(['verify', bundlePath], { from: 'user' }),
    );

    const output = logs.join('\n');
    expect(output).toContain('TAMPERED');
    expect(exitCode).toBe(1);
  });

  it('--json flag emits the raw VerificationReport JSON instead of rendered text', async () => {
    const { bundle, root } = await buildSealedBundle('run-json-1');
    const bundlePath = join(tmpDir, 'bundle.json');
    await writeFile(bundlePath, serializeBundle(bundle));

    const oc: OrchContext = {
      transport: makeFakeTransport(),
      anchor: anchorOf(root, 'external-immutable'),
    };
    const ctx = makeCtx(oc);
    const program = new Command();
    attachVerifyCmd(program, ctx);

    const { logs } = await captureLog(() =>
      program.parseAsync(['verify', bundlePath, '--json'], { from: 'user' }),
    );

    const output = logs.join('\n');
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('intact');
    expect(parsed).toHaveProperty('checks');
    expect(parsed.intact).toBe(true);
  });

  it('throws a clear error when anchor is not provided in orch context', async () => {
    const { bundle } = await buildSealedBundle('run-no-anchor');
    const bundlePath = join(tmpDir, 'bundle.json');
    await writeFile(bundlePath, serializeBundle(bundle));

    // No anchor in orch context
    const oc: OrchContext = { transport: makeFakeTransport() };
    const ctx = makeCtx(oc);
    const program = new Command();
    attachVerifyCmd(program, ctx);

    await expect(
      program.parseAsync(['verify', bundlePath], { from: 'user' }),
    ).rejects.toThrow('no anchor');
  });
});
