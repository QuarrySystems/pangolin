// Proves only that the SHIPPED EXAMPLE ARTIFACTS compose and run. Deep mechanics
// (lock fan-out, audit verify, DB-tamper-fails, no-secret-in-export, guarantee tier)
// are owned by the pangolin-orchestrator test suites and NOT re-tested here.

import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PangolinOrchestrator,
  SqliteRunStateStore,
  ManualTrigger,
  AuditLog,
  NoneSigner,
  LocalAnchor,
  MailboxSubmissionTransport,
  LocalDirMailbox,
  OperationsApi,
} from '@quarry-systems/pangolin-orchestrator';
import type { Run, Executor, FireContext } from '@quarry-systems/pangolin-orchestrator';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = resolve(__dirname, '../plan.json');

describe('demo-claims-appeals example', () => {
  it('plan.json is a valid fan-out Run', async () => {
    const raw = await readFile(PLAN_PATH, 'utf-8');
    const plan = JSON.parse(raw) as Run;

    expect(typeof plan.id).toBe('string');
    expect(plan.queue).toBe('default');
    expect(plan.items).toHaveLength(4);

    // The three appeal items each have exactly one resourceLocks entry and no deps.
    const appealItems = plan.items.filter((i) => i.id.startsWith('appeal-'));
    expect(appealItems).toHaveLength(3);
    for (const item of appealItems) {
      expect(item.resourceLocks).toHaveLength(1);
      expect(item.depends_on).toHaveLength(0);
    }

    // The verify item gates on all three appeal ids.
    const verifyItem = plan.items.find((i) => i.id === 'verify');
    expect(verifyItem).toBeDefined();
    expect(verifyItem!.depends_on).toHaveLength(3);
    for (const id of appealItems.map((i) => i.id)) {
      expect(verifyItem!.depends_on).toContain(id);
    }
  });

  it('a fake-executor run over the example plan completes and yields a verifiable bundle', async () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    const blobs = new Map<string, Uint8Array>();

    const fakeExecutor: Executor = {
      id: 'dispatch',
      async fire(item, ctx?: FireContext) {
        const dispatchHash = 'dh-' + item.id;
        const manifestRef = 'pangolin://manifests/' + dispatchHash;
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
        return {
          status: 'done' as const,
          output: { exitCode: 0 },
          resultRef: 'pangolin://artifacts/' + h,
        };
      },
    };

    const store = new SqliteRunStateStore();
    try {
      const anchor = new LocalAnchor(store);
      const auditLog = new AuditLog({ store, signer: NoneSigner, anchor });
      const orchestrator = new PangolinOrchestrator({
        store,
        executors: { dispatch: fakeExecutor },
        triggers: { manual: new ManualTrigger() },
        queues: { default: { concurrency: 2 } },
        auditLog,
      });

      const raw = await readFile(PLAN_PATH, 'utf-8');
      const plan = JSON.parse(raw) as Run;
      const runId = await orchestrator.submitRun(plan, 'human:test');

      for (let i = 0; i < 20; i++) {
        await orchestrator.tick('default');
        const statuses = orchestrator.getStatus(runId);
        const allTerminal = statuses.every((s) =>
          ['done', 'failed', 'skipped', 'cancelled'].includes(s.status),
        );
        if (allTerminal && statuses.length === 4) break;
      }

      const finalStatuses = orchestrator.getStatus(runId);
      expect(finalStatuses).toHaveLength(4);
      for (const s of finalStatuses) {
        expect(['done', 'failed', 'skipped', 'cancelled']).toContain(s.status);
      }

      const appealStatuses = finalStatuses.filter((s) => s.id.startsWith('appeal-'));
      expect(appealStatuses).toHaveLength(3);
      for (const s of appealStatuses) {
        expect(s.status).toBe('done');
        expect(typeof s.resultRef).toBe('string');
      }

      const verifyStatus = finalStatuses.find((s) => s.id === 'verify');
      expect(verifyStatus).toBeDefined();
      expect(verifyStatus!.status).toBe('done');

      const tmpDir = await mkdtemp(join(tmpdir(), 'pangolin-claims-test-'));
      try {
        const transport = new MailboxSubmissionTransport(new LocalDirMailbox(tmpDir));
        const auditExport = orchestrator.getAuditExport(runId);
        expect(auditExport.root).toBeDefined();
        await transport.publish({
          runId,
          kind: 'audit',
          body: auditExport,
          at: new Date().toISOString(),
        });

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
