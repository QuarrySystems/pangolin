// DRY: deep mechanics are owned elsewhere and are NOT re-tested here:
//   lock fan-out/serialize -> packages/agora-orchestrator/test/pressure-runner.test.ts SCENARIO 1
//   audit verify / DB-tamper-fails / no-secret-in-export / guarantee tier -> .../test/audit/acceptance.int.test.ts 1-4 + .../test/audit/bundle.test.ts
//   OperationsApi.audit read + errors -> .../test/operations-api.test.ts
// This file proves only that the SHIPPED EXAMPLE ARTIFACTS compose and run.

import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
} from '@quarry-systems/agora-orchestrator';
import type { Run, Executor, FireContext } from '@quarry-systems/agora-orchestrator';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = resolve(__dirname, '../plan.json');

// ---------------------------------------------------------------------------
// Test 1: plan.json shape
// ---------------------------------------------------------------------------

describe('offload-fanout example', () => {
  it('plan.json is a valid fan-out Run', async () => {
    const raw = await readFile(PLAN_PATH, 'utf-8');
    const plan = JSON.parse(raw) as Run;

    // Has an id and a default queue
    expect(typeof plan.id).toBe('string');
    expect(plan.queue).toBe('default');

    // Exactly 4 items total
    expect(plan.items).toHaveLength(4);

    // The three edit items each have exactly one resourceLocks entry
    const editItems = plan.items.filter((i) => i.id.startsWith('edit-'));
    expect(editItems).toHaveLength(3);
    for (const item of editItems) {
      expect(item.resourceLocks).toHaveLength(1);
    }

    // The verify item depends on all three edit item ids
    const verifyItem = plan.items.find((i) => i.id === 'verify');
    expect(verifyItem).toBeDefined();
    expect(verifyItem!.depends_on).toHaveLength(3);
    const editIds = editItems.map((i) => i.id);
    for (const depId of editIds) {
      expect(verifyItem!.depends_on).toContain(depId);
    }

    // All three edits have no depends_on
    for (const item of editItems) {
      expect(item.depends_on).toHaveLength(0);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 2: fake-executor run over the example plan
  // ---------------------------------------------------------------------------

  it('a fake-executor run over the example plan completes and yields a verifiable bundle', async () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

    // In-memory blob store for manifests + artifacts
    const blobs = new Map<string, Uint8Array>();

    // Fake executor that fires immediately and reconciles done
    const fakeExecutor: Executor = {
      id: 'dispatch',
      async fire(item, ctx?: FireContext) {
        const dispatchHash = 'dh-' + item.id;
        const manifestRef = 'agora://manifests/' + dispatchHash;
        blobs.set(
          manifestRef,
          enc({
            schemaVersion: 1,
            runId: ctx?.runId ?? '',
            itemId: item.id,
            parent: 'run:' + (ctx?.runId ?? ''),
            executor: 'dispatch',
            executorManifest: {},
            secretRefs: [],
            actor: ctx?.actor ?? '',
            firedAt: '2026-06-01T00:00:00Z',
            manifestHash: 'sha256:x',
          }),
        );
        return { dispatchHash, manifestRef };
      },
      async reconcile(h: string) {
        return { status: 'done' as const, output: { exitCode: 0 }, resultRef: 'agora://artifacts/' + h };
      },
    };

    // Real orchestrator with audit wired up (NoneSigner = no crypto overhead)
    // Outer try/finally ensures the store handle is always closed, even on early failure.
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

      // Submit and tick to completion
      const runId = orchestrator.submitRun(plan, 'human:test');

      // Tick until all items are terminal (max 20 ticks for safety)
      for (let i = 0; i < 20; i++) {
        await orchestrator.tick('default');
        const statuses = orchestrator.getStatus(runId);
        const allTerminal = statuses.every((s) =>
          ['done', 'failed', 'skipped', 'cancelled'].includes(s.status),
        );
        if (allTerminal && statuses.length === 4) break;
      }

      // Verify all items are terminal and have expected statuses
      const finalStatuses = orchestrator.getStatus(runId);
      expect(
        finalStatuses,
        `got: ${JSON.stringify(finalStatuses.map((s) => ({ id: s.id, status: s.status })))}`,
      ).toHaveLength(4);
      const terminal = ['done', 'failed', 'skipped', 'cancelled'];
      for (const s of finalStatuses) {
        expect(terminal).toContain(s.status);
      }

      // All 3 edit items done
      const editStatuses = finalStatuses.filter((s) => s.id.startsWith('edit-'));
      expect(editStatuses).toHaveLength(3);
      for (const s of editStatuses) {
        expect(s.status).toBe('done');
      }

      // Verify item done
      const verifyStatus = finalStatuses.find((s) => s.id === 'verify');
      expect(verifyStatus).toBeDefined();
      expect(verifyStatus!.status).toBe('done');

      // Each edit item has a resultRef
      for (const s of editStatuses) {
        expect(s.resultRef).toBeDefined();
        expect(typeof s.resultRef).toBe('string');
      }

      // Publish audit export via MailboxSubmissionTransport
      const tmpDir = await mkdtemp(join(tmpdir(), 'agora-fanout-test-'));
      try {
        const mbox = new LocalDirMailbox(tmpDir);
        const transport = new MailboxSubmissionTransport(mbox);

        // Get the audit export and publish it
        const auditExport = orchestrator.getAuditExport(runId);
        // root must be defined (sealed after all items terminal)
        expect(auditExport.root).toBeDefined();

        await transport.publish({ runId, kind: 'audit', body: auditExport, at: new Date().toISOString() });

        // Build OperationsApi and call .audit(runId)
        const api = new OperationsApi({
          transport,
          anchor,
          storage: {
            get: async (ref: string) => {
              const b = blobs.get(ref);
              if (!b) throw new Error('not found: ' + ref);
              return b;
            },
          },
        });

        const bundle = await api.audit(runId);

        // Assertions
        expect(bundle.report.intact).toBe(true);
        expect(bundle.report.claim).toBe('tamper-detecting');
        expect(bundle.report.anchorId).toBeDefined();
        expect(bundle.items).toHaveLength(4);
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    } finally {
      store.close();
    }
  });
});
