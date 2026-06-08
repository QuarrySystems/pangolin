// E2E: §9 live-AWS variant — Fargate + S3 cloud path.
//
// This is the high-cost / low-frequency complement to the local-Docker E2E
// in `runtime-adapter-seam.test.ts`. It exercises the full register +
// dispatch pipeline against REAL AWS services:
//
//   - `S3StorageProvider`            (real bucket)
//   - `FargateProvider`              (real ECS cluster + task definition)
//   - `AwsCredentialProvider`        (real AWS SDK credential chain)
//
// The dispatch boots a real worker container in Fargate, which fetches the
// registered subagent + capability + env bundles from S3, runs the
// `claude-code` adapter (or whatever the task definition's `pangolin-worker`
// container has installed), and writes back the terminal dispatch record.
// On the client side we then assert:
//
//   - `result.exitCode === 0` — the cloud pipeline completed cleanly.
//   - `result.resolved.subagent.contentHash` matches what `subagent.register()`
//     returned — the audit block is populated end-to-end with the exact
//     bytes that ran (the §4.3 "content hash drives identity" invariant
//     surviving the round-trip through S3 + Fargate + the worker).
//   - `result.resolved.capabilities[0].contentHash` matches what
//     `capabilities.register()` returned (same invariant for capability
//     bundles).
//
// ── Gating ────────────────────────────────────────────────────────────────
//
// The test is gated behind FOUR env vars and skips cleanly when ANY of them
// is unset. This file is intentionally low-frequency — it runs only on
// `main` push and on the `e2e-aws` workflow trigger, not on every PR (the
// cost of spinning up Fargate tasks per PR is prohibitive).
//
//   PANGOLIN_E2E_AWS_ENABLED                — explicit opt-in
//   PANGOLIN_E2E_AWS_BUCKET                 — S3 bucket the test reads/writes
//   PANGOLIN_E2E_AWS_CLUSTER                — ECS cluster the task runs in
//   PANGOLIN_E2E_AWS_TASK_DEFINITION_FAMILY — task definition family (the
//                                          `pangolin-worker` container image
//                                          is locked in here, not overridden
//                                          per-dispatch — see FargateProvider)
//
// Optional tuning:
//   PANGOLIN_E2E_AWS_SUBNETS                — comma-separated subnet IDs
//                                          (defaults to empty — relies on
//                                          the task def's awsvpc config)
//   PANGOLIN_E2E_AWS_SECURITY_GROUPS        — comma-separated security group IDs
//   PANGOLIN_E2E_AWS_REGION                 — AWS region (defaults to ambient
//                                          SDK chain — usually AWS_REGION)
//   PANGOLIN_E2E_AWS_S3_PREFIX              — bucket prefix (defaults to "")
//   PANGOLIN_E2E_WORKER_IMAGE               — worker image to dispatch
//                                          (must match what the task def
//                                          actually runs; image overrides
//                                          aren't permitted at RunTask, so
//                                          this is informational + the
//                                          §7.4 digest-pin gate)
//
// When `PANGOLIN_E2E_AWS_ENABLED` is unset, the dispatch case is `it.skip`
// and a sibling `it` asserts the skip path itself works (so the file
// always exits with at least one passing assertion).

// Relative imports to package sources — root package.json doesn't declare
// `@quarry-systems/*` as devDeps, so the e2e tests reach into each
// workspace package's source-tree barrel via the `.js`-suffixed NodeNext
// specifier (vitest transparently transpiles the resolved `.ts`). Same
// convention as `runtime-adapter-seam.test.ts` and
// `credentials-rejection.test.ts`.
import { PangolinClient } from '../../packages/pangolin-client/src/client.js';
// Side-effect import: installs `client.capabilities`, `client.subagent`,
// `client.env`, and `client.dispatch` getters on PangolinClient.prototype.
import '../../packages/pangolin-client/src/index.js';
import { StdoutResultSink } from '../../packages/pangolin-client/src/bundled-impls.js';
import { S3StorageProvider } from '../../packages/pangolin-storage-s3/src/index.js';
import { FargateProvider } from '../../packages/pangolin-providers-fargate/src/index.js';
import { AwsCredentialProvider } from '../../packages/pangolin-providers-aws-creds/src/index.js';
import { WORKER_IMAGE } from './helpers/worker-image.js';
import { describe, it, expect } from 'vitest';

// ── Gating helpers ────────────────────────────────────────────────────────

const ENABLED =
  !!process.env.PANGOLIN_E2E_AWS_ENABLED &&
  !!process.env.PANGOLIN_E2E_AWS_BUCKET &&
  !!process.env.PANGOLIN_E2E_AWS_CLUSTER &&
  !!process.env.PANGOLIN_E2E_AWS_TASK_DEFINITION_FAMILY;

const itIf = (cond: boolean): typeof it => (cond ? it : it.skip);

/** Comma-separated env-var → string[] with empty-aware trim. */
function csv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe('E2E: register + dispatch via Fargate + S3 (live AWS)', () => {
  // The unconditional skip-path assertion. This case ALWAYS runs and
  // verifies that the four-env-var gate logic is wired correctly: when
  // ANY required var is unset, `ENABLED` is false and the dispatch case
  // below becomes `it.skip`. Without this case, a host with none of the
  // env vars set would have a single `it.skip` and the file would report
  // zero PASSING tests, which makes "did the suite actually load?" harder
  // to tell apart from "everything skipped silently".
  it('skips cleanly when any required AWS env var is unset', () => {
    // The flag is a pure boolean derived from four env vars. If `ENABLED`
    // is true, the dispatch case below runs (and this assertion is just
    // a tautology); if `ENABLED` is false, the dispatch case is skipped
    // and this assertion documents WHY.
    const required = [
      'PANGOLIN_E2E_AWS_ENABLED',
      'PANGOLIN_E2E_AWS_BUCKET',
      'PANGOLIN_E2E_AWS_CLUSTER',
      'PANGOLIN_E2E_AWS_TASK_DEFINITION_FAMILY',
    ];
    const unset = required.filter((k) => !process.env[k]);
    if (unset.length === 0) {
      // All four set — the gate opens. The dispatch case runs; this
      // assertion documents that fact.
      expect(ENABLED).toBe(true);
    } else {
      // At least one unset — the gate closes. Assert the dispatch case
      // is correctly skipped (rather than silently passing or, worse,
      // attempting a real AWS call without credentials).
      expect(ENABLED).toBe(false);
    }
  });

  itIf(ENABLED)(
    'completes the cloud pipeline and returns a populated resolved audit block',
    async () => {
      // The bucket / cluster / task-def names are gated by `ENABLED` above
      // and are guaranteed non-empty here. Non-null assertions are safe.
      const bucket = process.env.PANGOLIN_E2E_AWS_BUCKET!;
      const cluster = process.env.PANGOLIN_E2E_AWS_CLUSTER!;
      const taskDefinitionFamily = process.env.PANGOLIN_E2E_AWS_TASK_DEFINITION_FAMILY!;
      const subnets = csv('PANGOLIN_E2E_AWS_SUBNETS');
      const securityGroups = csv('PANGOLIN_E2E_AWS_SECURITY_GROUPS');
      const s3Prefix = process.env.PANGOLIN_E2E_AWS_S3_PREFIX;

      // Unique namespace per run so concurrent / repeated invocations
      // never collide on a `(namespace, type, name)` registry path. The
      // `e2e-` prefix makes janitor scripts easy to write.
      const namespace = `e2e-${Date.now()}`;

      // Build the client: real S3 + Fargate + AWS credential chain. The
      // `fargate-prod` target is the convention from the spec body; any
      // string would do but using `fargate-prod` lines up with the
      // §9 example in the spec for grep-ability.
      const client = new PangolinClient({
        namespace,
        compute: {
          fargate: new FargateProvider({
            cluster,
            taskDefinitionFamily,
            subnets,
            securityGroups,
          }),
        },
        credentials: {
          aws: new AwsCredentialProvider(),
        },
        storage: new S3StorageProvider({
          bucket,
          ...(s3Prefix ? { prefix: s3Prefix } : {}),
        }),
        targets: {
          'fargate-prod': { compute: 'fargate', credentials: 'aws' },
        },
        resultSink: new StdoutResultSink(),
      });

      // Register a minimal capability + subagent + env triple. Same
      // shape as the Docker round-trip in `pangolin-client`'s integration
      // suite, just pointed at S3 instead of LocalStorage.
      const capRef = await client.capabilities.register({
        name: 'cap-e2e',
        files: { 'note.txt': 'fargate cloud path round trip' },
      });
      const subHandle = await client.subagent.register({
        name: 'sub-e2e',
        systemPrompt: 'noop subagent for e2e cloud-path test',
        capabilities: [capRef],
      });
      const envRef = await client.env.register({
        name: 'env-e2e',
        values: { LOG_LEVEL: 'info' },
      });

      // Fire the dispatch. `workerImage` is the digest-pinned worker
      // image — FargateProvider's `assertImagePinned` would throw on a
      // non-digest ref, so the helper's WORKER_IMAGE constant is already
      // in the right shape. Note: ECS does NOT permit overriding the
      // container image at RunTask time (it's locked in by the task
      // definition); we still pass the pin here so the §7.4 gate fires
      // client-side AND the audit trail records what the caller asked
      // for.
      const result = await client.dispatch({
        subagent: 'sub-e2e',
        env: 'env-e2e',
        target: 'fargate-prod',
        workerImage: WORKER_IMAGE,
      });

      // Acceptance criterion #1: clean exit. A non-zero exit here means
      // either the worker container itself failed, or a bundle fetch
      // failed, or the adapter (claude-code by default) failed — any
      // of which is a real regression worth investigating.
      expect(result.exitCode).toBe(0);

      // Acceptance criterion #2: the resolved audit block echoes the
      // exact content hashes returned by the register calls. This is
      // the §4.3 "exactly which bytes ran" contract surviving the full
      // S3 + Fargate round-trip. If S3 returned different bytes than
      // the register call wrote, the `IntegrityMismatchError` would have
      // fired upstream and we wouldn't reach here.
      expect(result.resolved.subagent.name).toBe('sub-e2e');
      expect(result.resolved.subagent.contentHash).toBe(subHandle.contentHash);

      expect(result.resolved.capabilities).toHaveLength(1);
      expect(result.resolved.capabilities[0]!.name).toBe('cap-e2e');
      expect(result.resolved.capabilities[0]!.contentHash).toBe(capRef.contentHash);

      expect(result.resolved.env).toHaveLength(1);
      expect(result.resolved.env![0]!.name).toBe('env-e2e');
      expect(result.resolved.env![0]!.contentHash).toBe(envRef.contentHash);

      // Sanity: dispatchId is the uuid v4 the client minted.
      expect(typeof result.dispatchId).toBe('string');
      expect(result.dispatchId).toMatch(/^[0-9a-f-]{36}$/);
    },
    // 15-minute timeout — Fargate cold-start (~30-60s for ENI allocation
    // + container pull) + worker boot + bundle fetches from S3 + sub-agent
    // exec + dispatch-record write. The local-Docker analogue runs in
    // seconds; cloud needs an order of magnitude more slack.
    900_000,
  );
});
