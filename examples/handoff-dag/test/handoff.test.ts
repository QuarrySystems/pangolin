// DRY: deep mechanics are owned elsewhere and are NOT re-tested here:
//   needs wiring / auto-union / resolve-at-fire -> packages/agora-orchestrator/test/needs*.test.ts
//   audit verify / DB-tamper-fails / guarantee tier -> .../test/audit/acceptance.int.test.ts
//   verifyBundle handoff closure -> .../test/audit/verify-bundle.test.ts
//   OperationsApi.audit read + errors -> .../test/operations-api.test.ts
// This file proves only that the SHIPPED EXAMPLE ARTIFACTS compose and run with
// provenance-sealed handoff: a 2-item plan (edit-a → apply-patch via needs) reaches
// done and bundle.report.checks.handoff.ok === true.

import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPLY_PATCH_SETUP_SH } from '../src/capabilities.js';
import {
  AgoraOrchestrator,
  SqliteRunStateStore,
  ManualTrigger,
  AuditLog,
  NoneSigner,
  LocalAnchor,
  MailboxSubmissionTransport,
  LocalDirMailbox,
  OperationsApi,
  buildManifest,
  verifyBundle,
} from '@quarry-systems/agora-orchestrator';
import type { Run, Executor, FireContext } from '@quarry-systems/agora-orchestrator';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = resolve(__dirname, '../plan.json');

// ---------------------------------------------------------------------------
// Test 1: plan.json shape
// ---------------------------------------------------------------------------

describe('handoff-dag example', () => {
  it('apply-patch setup script initializes git repo before applying the patch', () => {
    // The worker workspace is a fresh mkdtemp'd directory — not a git repo.
    // agora-setup.sh must run `git init` before `git apply`, otherwise `git apply`
    // exits non-zero and the worker fails.
    expect(APPLY_PATCH_SETUP_SH).toContain('git init');
    const initIdx = APPLY_PATCH_SETUP_SH.indexOf('git init');
    const applyIdx = APPLY_PATCH_SETUP_SH.indexOf('git apply');
    expect(applyIdx).toBeGreaterThan(initIdx);
  });

  it('plan.json declares the edit item and apply-patch item with needs only (no hand-written depends_on on apply-patch)', async () => {
    const raw = await readFile(PLAN_PATH, 'utf-8');
    const plan = JSON.parse(raw) as Run;

    // Has an id and a default queue
    expect(typeof plan.id).toBe('string');
    expect(plan.queue).toBe('default');

    // Exactly 2 items
    expect(plan.items).toHaveLength(2);

    // The edit item
    const editItem = plan.items.find((i) => i.id === 'edit-a');
    expect(editItem).toBeDefined();
    expect(editItem!.depends_on).toHaveLength(0);

    // The apply-patch item
    const applyItem = plan.items.find((i) => i.id === 'apply-patch');
    expect(applyItem).toBeDefined();

    // apply-patch has needs.patch binding edit-a
    expect(applyItem!.needs).toBeDefined();
    expect(applyItem!.needs!['patch']).toMatchObject({
      from: 'edit-a',
      select: { kind: 'patch' },
    });

    // apply-patch has NO hand-written depends_on — auto-union at submitRun adds it
    expect(applyItem!.depends_on).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 2: fake-executor run over the example plan — drives to done, checks bundle
  // ---------------------------------------------------------------------------

  it('a fake-executor run over the example plan completes with intact:true and checks.handoff.ok:true', async () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

    // In-memory blob store for manifests + artifacts
    const blobs = new Map<string, Uint8Array>();

    // Track resultRefs by dispatchHash so apply-patch can reference it in its manifest
    const resultRefByDispatchHash = new Map<string, string>();

    // Fake executor: fires immediately and reconciles done.
    // For items WITH inputRefs (apply-patch), builds a REAL buildManifest so the
    // handoff closure check can verify the inputRefs are sealed products.
    const fakeExecutor: Executor = {
      id: 'dispatch',
      async fire(item, ctx?: FireContext) {
        const dispatchHash = 'dh-' + item.id;
        // Extract inputRefs that the tick injected (for needs-wired items)
        const inputRefs = (item.inputs as Record<string, unknown>)?.inputRefs as Record<string, string> | undefined;

        const { manifest, bytes } = buildManifest({
          runId: ctx?.runId ?? '',
          itemId: item.id,
          executor: 'dispatch',
          executorManifest: {},
          secretRefs: [],
          actor: ctx?.actor ?? '',
          firedAt: new Date().toISOString(),
          submittedAt: ctx?.submittedAt,
          inputRefs,
        });

        const manifestRef = 'agora://manifests/' + dispatchHash;
        blobs.set(manifestRef, bytes);

        // For edit-a: produce a content-addressed patch artifact
        if (item.id === 'edit-a') {
          const patchBytes = enc({ type: 'patch', content: '--- a/file\n+++ b/file\n@@\n-old\n+new' });
          const resultRef = 'agora://artifacts/patch-' + dispatchHash;
          blobs.set(resultRef, patchBytes);
          resultRefByDispatchHash.set(dispatchHash, resultRef);
        }

        return { dispatchHash, manifestRef };
      },
      async reconcile(dispatchHash: string) {
        const resultRef = resultRefByDispatchHash.get(dispatchHash);
        return {
          status: 'done' as const,
          output: { exitCode: 0 },
          ...(resultRef ? { resultRef } : {}),
        };
      },
    };

    const store = new SqliteRunStateStore();
    try {
      const anchor = new LocalAnchor(store);
      const auditLog = new AuditLog({ store, signer: NoneSigner, anchor });
      const orchestrator = new AgoraOrchestrator({
        store,
        executors: { dispatch: fakeExecutor },
        triggers: { manual: new ManualTrigger() },
        queues: { default: { concurrency: 2 } },
        auditLog,
      });

      // Load the real example plan.json
      const raw = await readFile(PLAN_PATH, 'utf-8');
      const plan = JSON.parse(raw) as Run;

      // Submit (normalizes needs → depends_on auto-union)
      const runId = orchestrator.submitRun(plan, 'human:test');

      // Tick until all items are terminal (max 20 ticks for safety)
      for (let i = 0; i < 20; i++) {
        await orchestrator.tick('default');
        const statuses = orchestrator.getStatus(runId);
        const allTerminal = statuses.every((s) =>
          ['done', 'failed', 'skipped', 'cancelled'].includes(s.status),
        );
        if (allTerminal && statuses.length === 2) break;
      }

      // Verify all items are terminal
      const finalStatuses = orchestrator.getStatus(runId);
      expect(
        finalStatuses,
        `got: ${JSON.stringify(finalStatuses.map((s) => ({ id: s.id, status: s.status })))}`,
      ).toHaveLength(2);

      // Both items done
      for (const s of finalStatuses) {
        expect(s.status, `item ${s.id} should be done`).toBe('done');
      }

      // edit-a has a resultRef (the patch)
      const editStatus = finalStatuses.find((s) => s.id === 'edit-a');
      expect(editStatus?.resultRef).toBeDefined();

      // apply-patch has a manifestRef (its manifest records inputRefs)
      const applyStatus = finalStatuses.find((s) => s.id === 'apply-patch');
      expect(applyStatus?.manifestRef).toBeDefined();

      // Publish audit export via MailboxSubmissionTransport
      const tmpDir = await mkdtemp(join(tmpdir(), 'agora-handoff-test-'));
      try {
        const mbox = new LocalDirMailbox(tmpDir);
        const transport = new MailboxSubmissionTransport(mbox);

        // Get the audit export (sealed after all items terminal)
        const auditExport = orchestrator.getAuditExport(runId);
        expect(auditExport.root).toBeDefined();

        await transport.publish({ runId, kind: 'audit', body: auditExport, at: new Date().toISOString() });

        // Build OperationsApi and call .audit(runId)
        const api = new OperationsApi({
          transport,
          anchor,
          storage: {
            get: async (ref: string) => {
              const b = blobs.get(ref);
              if (!b) throw new Error('blob not found: ' + ref);
              return b;
            },
          },
        });

        // assembleBundle returns the base bundle (handoff check is n/a at this point)
        const bundle = await api.audit(runId);

        // verifyBundle adds the handoff closure check
        const report = await verifyBundle(bundle, { anchor });

        // Key assertions
        expect(report.intact, `report.intact should be true; failure: ${report.failure}`).toBe(true);
        expect(report.checks.handoff.ok, `handoff check should be true; detail: ${report.checks.handoff.detail}`).toBe(true);
        expect(report.checks.handoff.detail).toMatch(/input ref/);

        // The base bundle report is also intact (chain + anchor)
        expect(bundle.report.intact).toBe(true);
        expect(bundle.report.claim).toBe('tamper-detecting');
        expect(bundle.items).toHaveLength(2);
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    } finally {
      store.close();
    }
  });
});
