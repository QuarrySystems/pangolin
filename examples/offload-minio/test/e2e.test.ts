// examples/offload-minio/test/e2e.test.ts
//
// E2E tests for the MinIO-backed offload demo.
// Gated on PANGOLIN_RUN_E2E: these tests require a live stack
// (MinIO container + serve container + worker image) and are SKIPPED
// in normal CI / dev runs when the env var is absent.
//
// To run the live suite:
//   PANGOLIN_RUN_E2E=1 PANGOLIN_S3_ENDPOINT=http://localhost:9000 pnpm test

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  AuditLog,
  LocalAnchor,
  NoneSigner,
  verify,
} from '@quarry-systems/pangolin-orchestrator';
import type {
  AuditStore,
  AuditEntryRow,
  AnchoredRoot,
} from '@quarry-systems/pangolin-orchestrator';

// Gate: skip unless the operator explicitly opts in to the live stack.
const live = process.env.PANGOLIN_RUN_E2E ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Minimal in-memory AuditStore — used only in Case 2.
// ---------------------------------------------------------------------------
function makeMemoryStore(): AuditStore & { _rows: AuditEntryRow[]; _root: AnchoredRoot | undefined } {
  const rows: AuditEntryRow[] = [];
  let root: AnchoredRoot | undefined;
  return {
    _rows: rows,
    get _root() { return root; },
    appendAuditEntry(row: AuditEntryRow): void {
      rows.push(row);
    },
    getAuditEntries(runId: string): AuditEntryRow[] {
      return rows.filter((r) => r.runId === runId);
    },
    getAuditChainHead(runId: string): string {
      const filtered = rows.filter((r) => r.runId === runId);
      return filtered.length > 0 ? filtered[filtered.length - 1]!.entryHash : '';
    },
    putAuditRoot(r: AnchoredRoot): void {
      root = r;
    },
    getAuditRoot(_epochId: string): AnchoredRoot | undefined {
      return root;
    },
    // RunStateStore methods — not used in audit tests but satisfy the interface
    // if AuditStore is a subset; AuditStore is a separate interface so none needed.
  } as AuditStore & { _rows: AuditEntryRow[]; _root: AnchoredRoot | undefined };
}

live('offload-minio e2e — live stack required', () => {
  it('all 4 edits reach done with result_refs + external-immutable audit bundle', async () => {
    // Spawn the host driver (tsx src/index.ts) as a child process and assert it
    // exits 0.  The driver encodes all success conditions internally:
    //   - all items reach 'done'
    //   - result_refs present for edit items
    //   - bundle.report.intact === true
    //   - bundle.report.guarantee === 'external-immutable'
    // It sets process.exitCode = 1 on any failure, so exit 0 ↔ full success.
    const exampleDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const result = spawnSync('tsx', ['src/index.ts'], {
      cwd: exampleDir,
      env: {
        ...process.env,
        PANGOLIN_S3_ENDPOINT: process.env.PANGOLIN_S3_ENDPOINT ?? 'http://localhost:9000',
        PANGOLIN_S3_ACCESS_KEY: process.env.PANGOLIN_S3_ACCESS_KEY ?? 'minioadmin',
        PANGOLIN_S3_SECRET_KEY: process.env.PANGOLIN_S3_SECRET_KEY ?? 'minioadmin',
      },
      timeout: 300_000,
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      // Surface stdout/stderr to make failures debuggable.
      console.error('--- driver stdout ---\n', result.stdout);
      console.error('--- driver stderr ---\n', result.stderr);
    }

    // The only assertion: driver exits 0 ↔ entire run succeeded.
    expect(result.status).toBe(0);
  });

  it('tampering a persisted audit entry fails verification', async () => {
    // Self-contained tamper-detection assertion using the orchestrator's own
    // AuditLog + LocalAnchor + verify() function.
    //
    // We do NOT need to reach the live MinIO stack for this assertion — the
    // detection logic lives entirely in the orchestrator package and runs under
    // PANGOLIN_RUN_E2E just like the driver test above.
    //
    // Steps:
    //   1. Build an in-memory AuditStore and populate it via AuditLog.
    //   2. Seal the epoch → LocalAnchor writes the Merkle root.
    //   3. verify() confirms intact === true.
    //   4. Mutate one stored entry's entryHash (simulates corruption).
    //   5. verify() must report intact === false.

    const runId = 'tamper-test-run';
    const store = makeMemoryStore();
    const anchor = new LocalAnchor(store);
    const log = new AuditLog({ store, signer: NoneSigner, anchor });

    // Append two entries.
    log.append({ runId, kind: 'run.submitted', actor: 'human:test', at: new Date().toISOString() });
    log.append({ runId, kind: 'item.fired', itemId: 'item-1', status: 'dispatched', at: new Date().toISOString() });

    // Seal the epoch — anchors the Merkle root.
    await log.sealEpoch(runId);

    // Verify the intact (un-tampered) log.
    const reportBefore = await verify(runId, { store, anchor });
    expect(reportBefore.intact).toBe(true);

    // Tamper: overwrite the first entry's stored entryHash with garbage.
    const rows = store._rows;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // Direct mutation of the row in the in-memory array (simulates storage corruption).
    (rows[0] as { entryHash: string }).entryHash = 'deadbeef'.repeat(8);

    // Verify again — the chain no longer matches the anchored Merkle root.
    const reportAfter = await verify(runId, { store, anchor });
    expect(reportAfter.intact).toBe(false);
  });
});
