// appendable-stream — pattern-aware open-ended run, $0 CI demo.
//
// Demonstrates: an external producer submits a seed run with openEnded:true to a
// patterned queue, pushes items across ≥2 waves via transport.extend, the pattern
// routes them (onTaskDone spawns a followup per pushed item), the producer sends a
// close, and the sealed bundle verifies intact over the grown+routed graph.
//
// Runs entirely with a fake in-proc executor — no Docker, no ANTHROPIC_API_KEY.
//
// Export:   runAppendableStream()  — used by the test (and the CLI entrypoint).

import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PangolinOrchestrator,
  SqliteRunStateStore,
  ManualTrigger,
  AuditLog,
  LocalAnchor,
  NoneSigner,
  MailboxSubmissionTransport,
  LocalDirMailbox,
  serve,
  verifyBundle,
} from '@quarry-systems/pangolin-orchestrator';
import type {
  Executor,
  FireContext,
  Pattern,
  PatternContext,
  SpawnDirective,
  ItemState,
  Run,
  AuditBundle,
  StatusItem,
} from '@quarry-systems/pangolin-orchestrator';

// ---------------------------------------------------------------------------
// Minimal inline pattern: for each terminal item whose id does NOT end in
// '-followup', spawn exactly one '<id>-followup' item. Idempotent by id.
// ---------------------------------------------------------------------------
const followupPattern: Pattern = {
  id: 'followup',

  plan(run: Run): Run {
    // No pre-expansion needed for this pattern.
    return run;
  },

  onTaskDone(item: ItemState, ctx: PatternContext): SpawnDirective | null {
    // Don't spawn from cancelled items or items that are themselves followups.
    if (item.status === 'cancelled') return null;
    if (item.id.endsWith('-followup')) return null;

    const followupId = `${item.id}-followup`;
    // Idempotent: skip if already in the run.
    const alreadyPresent = ctx.runItems.some((i) => i.id === followupId);
    if (alreadyPresent) return null;

    return {
      items: [
        {
          id: followupId,
          executor: 'dispatch',
          inputs: { parentId: item.id },
          depends_on: [],
          resourceLocks: [],
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Fake in-proc executor — drives items to done immediately. No Docker/Claude.
// ---------------------------------------------------------------------------
function makeFakeExecutor(): Executor {
  return {
    id: 'dispatch',
    async fire(item: ItemState, _ctx?: FireContext) {
      return { dispatchHash: `fake-${item.id}` };
    },
    async reconcile(_hash: string) {
      return { status: 'done' as const };
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function stamp(): string {
  return new Date().toISOString();
}

export interface AppendableStreamResult {
  bundle: AuditBundle;
  items: StatusItem[];
}

// ---------------------------------------------------------------------------
// Main: wire + run + return { bundle, items }.
// ---------------------------------------------------------------------------
export async function runAppendableStream(): Promise<AppendableStreamResult> {
  const runDir = await mkdtemp(join(tmpdir(), 'pangolin-appendable-'));
  const mailboxDir = join(runDir, 'mailbox');
  await mkdir(mailboxDir, { recursive: true });

  const store = new SqliteRunStateStore();
  const ac = new AbortController();
  let servePromise: Promise<void> | undefined;
  try {
    // 1. Audit primitives (NoneSigner = no crypto overhead in CI).
    const anchor = new LocalAnchor(store);
    const auditLog = new AuditLog({ store, signer: NoneSigner, anchor });

    // 2. Orchestrator: fake executor + followup pattern on the 'patterned-q' queue.
    const orchestrator = new PangolinOrchestrator({
      store,
      executors: { dispatch: makeFakeExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { 'patterned-q': { concurrency: 10, pattern: followupPattern } },
      defaultQueue: 'patterned-q',
      auditLog,
    });

    // 3. Transport + serve loop.
    const transport = new MailboxSubmissionTransport(new LocalDirMailbox(mailboxDir));
    servePromise = serve({
      orchestrator,
      transport,
      queue: 'patterned-q',
      signal: ac.signal,
      tickIntervalMs: 15,
    });

    const runId = `appendable-stream-${Date.now()}`;
    const actor = 'app:appendable-stream';

    // 4. Submit the initial run: one seed item, openEnded:true.
    await transport.submit({
      run: {
        id: runId,
        queue: 'patterned-q',
        items: [
          {
            id: 'seed',
            executor: 'dispatch',
            inputs: { wave: 0 },
            depends_on: [],
            resourceLocks: [],
          },
        ],
        openEnded: true,
      },
      actor,
      submittedAt: stamp(),
    });

    // Give the serve loop one beat to ingest the submission.
    await sleep(50);

    // 5. Wave 1: push two more items.
    await transport.extend({
      runId,
      items: [
        {
          id: 'wave1-a',
          executor: 'dispatch',
          inputs: { wave: 1, label: 'a' },
          depends_on: [],
          resourceLocks: [],
        },
        {
          id: 'wave1-b',
          executor: 'dispatch',
          inputs: { wave: 1, label: 'b' },
          depends_on: [],
          resourceLocks: [],
        },
      ],
      actor,
      at: stamp(),
    });

    await sleep(50);

    // 6. Wave 2: one more item.
    await transport.extend({
      runId,
      items: [
        {
          id: 'wave2-c',
          executor: 'dispatch',
          inputs: { wave: 2, label: 'c' },
          depends_on: [],
          resourceLocks: [],
        },
      ],
      actor,
      at: stamp(),
    });

    await sleep(50);

    // 7. Close the run — the seal gate may now fire once all items go terminal.
    await transport.control({ kind: 'close', target: runId, actor, at: stamp() });

    // 8. Poll the outbox for the audit record (up to 5 s).
    let auditBody: unknown;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const recs = await transport.readOutbox(runId);
      const auditRec = recs.filter((r) => r.kind === 'audit').at(-1);
      if (auditRec) {
        auditBody = auditRec.body;
        break;
      }
      await sleep(30);
    }
    if (!auditBody) throw new Error('audit record never appeared in outbox within 5 s');

    // 10. Assemble final item statuses from the orchestrator (still-live store).
    const items = orchestrator.getStatus(runId);

    // 11. Build and verify the bundle.
    //     We use assembleBundle-equivalent logic via verifyBundle directly on the export.
    //     The audit export is already in auditBody (what serve published to the outbox).
    const { assembleBundle } = await import('@quarry-systems/pangolin-orchestrator');
    const exp = auditBody as Parameters<typeof assembleBundle>[0];

    // Storage for manifests: our fake executor never minted real manifests, so
    // provide an empty store (missing manifests are silently skipped by assembleBundle).
    const emptyStorage = {
      async get(ref: string): Promise<Uint8Array> {
        throw new Error(`storage: not found: ${ref}`);
      },
    };

    const bundle = await assembleBundle(exp, { anchor, storage: emptyStorage });

    // verifyBundle re-checks the bundle against the live anchor (tamper-detecting).
    const report = await verifyBundle(bundle, { anchor });
    const verifiedBundle = { ...bundle, report };

    return { bundle: verifiedBundle, items };
  } finally {
    ac.abort();
    await servePromise?.catch(() => {});
    store.close();
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  try {
    const { bundle, items } = await runAppendableStream();
    console.log('=== appendable-stream result ===');
    console.log(`  intact:    ${bundle.report.intact}`);
    console.log(`  claim:     ${bundle.report.claim}`);
    console.log(`  items:     ${items.length}`);
    for (const it of items) {
      console.log(`    ${it.id}: ${it.status}`);
    }
    if (!bundle.report.intact) {
      console.error('bundle is NOT intact — run failed');
      process.exitCode = 1;
    } else {
      console.log('=== appendable-stream OK ===');
    }
  } catch (err) {
    console.error('appendable-stream crashed:', err);
    process.exitCode = 1;
  }
}

// Run when invoked directly (not imported by the test). Standard ESM main-module
// check: the module URL equals the file URL of the script node/tsx was given.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
