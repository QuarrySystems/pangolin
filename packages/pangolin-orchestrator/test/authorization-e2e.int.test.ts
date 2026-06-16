// packages/pangolin-orchestrator/test/authorization-e2e.int.test.ts
//
// End-to-end authorization seal tests (Task 11 — integration capstone).
//
// Scenario 1 — sealed-evidence path (allow):
//   A ConfigAuthorizer denies 'write-impure' items. An ALLOWED item ('pure')
//   flows through submit + fire normally. The assembled bundle's manifest
//   carries `authorization.verdict === 'allow'`. verifyBundle reports
//   authzTier === 'recorded' and intact === true.
//
// Scenario 1b — Manifest-integrity negative:
//   Mutating the sealed authorization.verdict on a manifest after assembly
//   is caught by verifyBundle: intact === false, failure === 'manifest'.
//
// Scenario 2 — submit-deny rejects:
//   Submitting a run that contains a 'write-impure' item (as declared via a
//   subagentShape whose effectTier === 'write-impure') throws with a message
//   matching /denied by policy/ and nothing is queued.
//
// Harness reuse: mirrors the pattern-dogfood.int.test.ts / acceptance.int.test.ts
// approach — makeOrch + idKeyedExecutor from pattern-harness, extended with an
// authorization-aware executor that seals ctx.authorization into the manifest.

import { describe, it, expect } from 'vitest';
import { SqliteRunStateStore } from '../src/runstate/sqlite.js';
import {
  makeOrch,
  driveUntilDone,
  storageFromBlobs,
} from './fixtures/pattern-harness.js';
import { assembleBundle } from '../src/audit/bundle.js';
import { verifyBundle } from '../src/audit/verify-bundle.js';
import { createConfigAuthorizer } from '../src/audit/authorizer.js';
import { buildManifest } from '../src/audit/manifest.js';
import { buildPangolinUri, computeContentHash } from '@quarry-systems/pangolin-core';
import type { Executor, FireContext, WorkItem } from '../src/contracts/index.js';
import type { PackRegistry } from '../src/packs/registry.js';
import type { Authorizer } from '@quarry-systems/pangolin-core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal duck-typed pack registry so the orchestrator resolves effectTier from a shape.
 *  The inputSchema's safeParse always passes (pure structural shape, no validation needed here).
 *  Cast to PackRegistry so the orchestrator type-checks; duck typing works because the orchestrator
 *  only calls `.get(id)` and `.has(id)` on the registry at runtime. */
function makeMinimalPacks(shapeId: string, effectTier: string): PackRegistry {
  const fake = {
    get(id: string) {
      if (id !== shapeId) return undefined;
      return {
        id: shapeId,
        effectTier,
        inputSchema: {
          safeParse(_: unknown) { return { success: true as const, data: _ }; },
        },
      };
    },
    has(id: string) {
      return id === shapeId;
    },
  };
  return fake as unknown as PackRegistry;
}

/**
 * Authorization-aware executor.
 *
 * Mirrors idKeyedExecutor from pattern-harness.ts but additionally seals
 * `ctx.authorization` into the manifest so the bundle carries the decision.
 * This is what the production DispatchExecutor does at fire-time.
 *
 * All items resolve as 'done' on reconcile — behavior-neutral.
 */
function authzAwareExecutor(blobs: Map<string, Uint8Array>, namespace = 'ns'): Executor {
  const dispatchMap = new Map<string, string>();
  let counter = 0;

  return {
    id: 'dispatch',

    async fire(item: WorkItem, ctx?: FireContext) {
      const idx = ++counter;
      const { bytes } = buildManifest({
        runId: ctx?.runId ?? '',
        itemId: item.id,
        executor: 'dispatch',
        executorManifest: {},
        secretRefs: [],
        actor: ctx?.actor ?? 'human:test',
        firedAt: new Date().toISOString(),
        // Seal the authorization decision from FireContext into the manifest.
        authorization: ctx?.authorization,
      });

      // Mint a content-addressed URI for the manifest (mirrors DispatchExecutor).
      const contentHash = computeContentHash(bytes);
      const manifestRef = buildPangolinUri({
        namespace,
        type: 'manifest',
        name: `item-${idx}`,
        contentHash,
      });
      blobs.set(manifestRef, bytes);

      const dispatchHash = `d-${ctx?.runId ?? ''}-${item.id}-${idx}`;
      dispatchMap.set(dispatchHash, item.id);

      return { dispatchHash, manifestRef };
    },

    async reconcile(dispatchHash: string) {
      const itemId = dispatchMap.get(dispatchHash);
      if (itemId === undefined) return null;
      return { status: 'done' as const };
    },
  };
}

// ---------------------------------------------------------------------------
// Policy fixture
// ---------------------------------------------------------------------------

/** A ConfigAuthorizer that denies any effectClass === 'write-impure'. */
const DENY_WRITE_IMPURE_AUTHORIZER = createConfigAuthorizer({
  principal: 'op:acme',
  policyRef: 'sha256:rules',
  rules: [{ deny: { effectClass: 'write-impure' }, reason: 'writes require review' }],
});

// ---------------------------------------------------------------------------
// Scenario 1 — sealed-evidence allow path
// ---------------------------------------------------------------------------

describe('authorization-e2e: Scenario 1 — sealed-evidence allow path', () => {
  it(
    'allowed (unknown effectClass) item: manifest carries authorization.allow, authzTier=recorded, intact=true',
    async () => {
      const blobs = new Map<string, Uint8Array>();
      const store = new SqliteRunStateStore();

      const executor = authzAwareExecutor(blobs);
      const { orch, anchor } = makeOrch(store, executor, {
        authorizer: DENY_WRITE_IMPURE_AUTHORIZER,
      });

      // Raw item (no subagentShape) → effectClass resolved as 'unknown' by tick.ts.
      // 'unknown' is not 'write-impure', so the policy allows it.
      const runId = await orch.submitRun(
        {
          id: 'authz-allow-1',
          queue: 'default',
          items: [
            {
              id: 'item-a',
              executor: 'dispatch',
              inputs: {},
              depends_on: [],
              resourceLocks: [],
            },
          ],
        },
        'human:op',
      );

      await driveUntilDone(orch, 16, runId);

      // Run must be sealed (all items done → epoch sealed).
      const exp = orch.getAuditExport(runId);
      expect(exp.root).toBeDefined();

      // Assemble the bundle.
      const storage = storageFromBlobs(blobs);
      const bundle = await assembleBundle(exp, { anchor, storage });

      // The bundle carries exactly one manifest (item-a).
      expect(bundle.manifests).toHaveLength(1);
      const m = bundle.manifests[0]!;

      // The manifest must have authorization sealed with verdict 'allow'.
      expect(m.authorization).toBeDefined();
      expect(m.authorization!.verdict).toBe('allow');
      expect(m.authorization!.effectClass).toBeDefined();
      expect(m.authorization!.principal).toBe('op:acme');

      // verifyBundle: intact + authzTier.
      const report = await verifyBundle(bundle, { anchor });
      expect(report.intact).toBe(true);
      expect(report.authzTier).toBe('recorded');
    },
  );
});

// ---------------------------------------------------------------------------
// Scenario 1b — Manifest-integrity negative
// ---------------------------------------------------------------------------

describe('authorization-e2e: Scenario 1b — manifest-integrity negative', () => {
  it(
    'mutating bundle.manifests[0].authorization.verdict after assembly → intact=false, failure=manifest',
    async () => {
      const blobs = new Map<string, Uint8Array>();
      const store = new SqliteRunStateStore();

      const executor = authzAwareExecutor(blobs);
      const { orch, anchor } = makeOrch(store, executor, {
        authorizer: DENY_WRITE_IMPURE_AUTHORIZER,
      });

      const runId = await orch.submitRun(
        {
          id: 'authz-integrity-neg',
          queue: 'default',
          items: [
            {
              id: 'item-b',
              executor: 'dispatch',
              inputs: {},
              depends_on: [],
              resourceLocks: [],
            },
          ],
        },
        'human:op',
      );

      await driveUntilDone(orch, 16, runId);

      const exp = orch.getAuditExport(runId);
      expect(exp.root).toBeDefined(); // sealed before mutation

      const storage = storageFromBlobs(blobs);
      const bundle = await assembleBundle(exp, { anchor, storage });

      // Pre-mutation: intact.
      const cleanReport = await verifyBundle(bundle, { anchor });
      expect(cleanReport.intact).toBe(true);

      // Mutate the sealed authorization — the manifest self-hash no longer matches.
      const m = bundle.manifests[0];
      expect(m).toBeDefined();
      expect(m!.authorization).toBeDefined();
      m!.authorization!.verdict = 'deny'; // tamper the allow decision to deny

      // Re-verify: manifest integrity check must catch the mutation.
      const tamperReport = await verifyBundle(bundle, { anchor });
      expect(tamperReport.intact).toBe(false);
      expect(tamperReport.failure).toBe('manifest');
    },
  );
});

// ---------------------------------------------------------------------------
// Scenario 2 — submit-deny rejects
// ---------------------------------------------------------------------------

describe('authorization-e2e: Scenario 2 — submit-deny rejects', () => {
  it(
    'a write-impure item (via subagentShape) is rejected at submitRun with /denied by policy/; nothing queued',
    async () => {
      const SHAPE_ID = 'test.write-shape';
      const store = new SqliteRunStateStore();
      const blobs = new Map<string, Uint8Array>();

      const executor = authzAwareExecutor(blobs);
      const packs = makeMinimalPacks(SHAPE_ID, 'write-impure');

      const { orch } = makeOrch(store, executor, {
        authorizer: DENY_WRITE_IMPURE_AUTHORIZER,
        packs,
      });

      // Submitting a run with a write-impure shape must throw before anything is queued.
      await expect(
        orch.submitRun(
          {
            id: 'authz-deny-submit',
            queue: 'default',
            items: [
              {
                id: 'item-c',
                executor: 'dispatch',
                subagentShape: SHAPE_ID,
                inputs: {},
                depends_on: [],
                resourceLocks: [],
              },
            ],
          },
          'human:op',
        ),
      ).rejects.toThrow(/denied by policy/);

      // Nothing was queued: the store has no items for this run.
      expect(store.getItems('authz-deny-submit')).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Scenario 2b — fire-time deny (belt-and-suspenders)
// ---------------------------------------------------------------------------

describe('authorization-e2e: Scenario 2b — fire-time deny via actor gate', () => {
  it(
    'item denied at fire-phase: status=denied, item.denied audit entry, authzTier=recorded on sealed run',
    async () => {
      // Raw Authorizer: allows at submit-phase, denies at fire-phase for a specific actor.
      // This isolates the fire-gate path from the submit-gate path.
      const FIRE_ONLY_DENY: Authorizer = {
        async authorize(ctx) {
          const at = ctx.at ?? new Date(0).toISOString();
          if (ctx.phase === 'fire' && ctx.actor === 'human:fire-deny') {
            return {
              verdict: 'deny',
              principal: 'op:acme',
              policyRef: 'sha256:fire-only-rules',
              effectClass: ctx.effectClass,
              reason: 'actor blocked at fire',
              at,
            };
          }
          return {
            verdict: 'allow',
            principal: 'op:acme',
            policyRef: 'sha256:fire-only-rules',
            effectClass: ctx.effectClass,
            at,
          };
        },
      };

      const store = new SqliteRunStateStore();
      const blobs = new Map<string, Uint8Array>();
      const executor = authzAwareExecutor(blobs);
      const { orch, anchor } = makeOrch(store, executor, {
        authorizer: FIRE_ONLY_DENY,
      });

      // Submit with actor 'human:fire-deny': submit-phase passes (FIRE_ONLY_DENY allows at submit),
      // fire-phase blocks (FIRE_ONLY_DENY denies this actor at fire).
      const runId = await orch.submitRun(
        {
          id: 'authz-fire-deny',
          queue: 'default',
          items: [
            {
              id: 'item-d',
              executor: 'dispatch',
              inputs: {},
              depends_on: [],
              resourceLocks: [],
            },
          ],
        },
        'human:fire-deny',
      );

      // Drive by tick count (denied is terminal but not in driveUntilDone's terminal set).
      for (let i = 0; i < 8; i++) await orch.tick('default');

      // The item must be 'denied'.
      const statuses = orch.getStatus(runId);
      expect(statuses[0]?.status).toBe('denied');

      // The run seals even with denied items (denied is terminal).
      const exp = orch.getAuditExport(runId);
      expect(exp.root).toBeDefined();

      // Assemble the bundle. No manifests because fire() was never called (denied before fire).
      const storage = storageFromBlobs(blobs);
      const bundle = await assembleBundle(exp, { anchor, storage });

      // The audit log must contain an 'item.denied' entry with authorization.verdict=deny.
      const deniedEntries = bundle.auditLog.entries.filter((e) => e.kind === 'item.denied');
      expect(deniedEntries).toHaveLength(1);
      expect(deniedEntries[0]!.authorization?.verdict).toBe('deny');

      // verifyBundle: authzTier=recorded because the denied entry carries authorization.
      const report = await verifyBundle(bundle, { anchor });
      expect(report.intact).toBe(true);
      expect(report.authzTier).toBe('recorded');
    },
  );
});
