// Orchestrator-offload battle-test / on-ramp.
//
// Drives the FULL orchestrator path end-to-end against a real container:
//   PangolinOrchestrator.tick → DispatchExecutor.fire → client.dispatch.fire
//   → local-docker worker runs the subagent → reconcile → WorkItemResult.
//
// Where examples/hello-world exercises a single `client.dispatch(...)`, this
// exercises PR1+PR2+PR3 composed: a Run of one WorkItem flowing through the
// queue/dep/tick engine and the DispatchExecutor's fire-and-reconcile bridge.
//
// Prerequisites (a real cold-run, not a unit test):
//   - Docker reachable (local Desktop, or DOCKER_HOST → a remote daemon).
//   - The worker image pullable/pinned: ghcr.io/quarrysystems/pangolin-worker:latest.
//   - ANTHROPIC_API_KEY in the environment (the worker invokes `claude --print`).
//     Run via:  pnpm start:env   (reads ../../.env)   or export the var and `pnpm start`.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PangolinClient,
  NoopCredentialProvider,
  StdoutResultSink,
} from '@quarry-systems/pangolin-client';
import { LocalStorageProvider } from '@quarry-systems/pangolin-storage-local';
import { LocalDockerProvider } from '@quarry-systems/pangolin-providers-local-docker';
import { LocalSecretStore } from '@quarry-systems/pangolin-secret-store';
import {
  PangolinOrchestrator,
  SqliteRunStateStore,
  ManualTrigger,
  DispatchExecutor,
} from '@quarry-systems/pangolin-orchestrator';

const WORKER_IMAGE = 'ghcr.io/quarrysystems/pangolin-worker:latest';
const RUN_TIMEOUT_MS = 180_000; // a real claude run can take a while; poll up to 3 min
const TICK_INTERVAL_MS = 2_000;

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      'ANTHROPIC_API_KEY is not set. Run `pnpm start:env` (reads ../../.env) or export it.',
    );
    process.exit(1);
  }

  const storageRoot = await mkdtemp(join(tmpdir(), 'pangolin-offload-'));
  // Stable per-host secret store dir: fixed path so the LocalDockerProvider can
  // reliably bind-mount it into the container across ticks. Not a mkdtemp so
  // the dir survives between the fire() call and the worker reading from it.
  const secretStoreDir = join(tmpdir(), 'pangolin-offload-secrets');
  const secretStore = new LocalSecretStore({ dir: secretStoreDir });
  const store = new SqliteRunStateStore(); // :memory: — single-process orchestrator

  try {
    // 1. Wire a local-stack client (same shape as examples/hello-world).
    const client = new PangolinClient({
      namespace: 'orchestrator-offload',
      compute: { 'local-docker': new LocalDockerProvider({ allowUnpinnedImage: true }) },
      credentials: { none: new NoopCredentialProvider() },
      storage: new LocalStorageProvider({ rootDir: storageRoot }),
      secretStores: { local: secretStore },
      targets: { local: { compute: 'local-docker', credentials: 'none', secretStore: 'local' } },
      resultSink: new StdoutResultSink(),
    });

    // 2. Register a trivial subagent. The API key is NOT registered as an env-bundle
    //    value — the env firewall (correctly) rejects credential-shaped plaintext env.
    //    It travels as a deploy-time executor secret instead (step 3).
    await client.capabilities.register({
      name: 'echo-cap',
      files: { 'pangolin-setup.sh': '#!/bin/sh\necho "hello from pangolin-offload worker"\n' },
    });
    await client.subagent.register({
      name: 'echo',
      systemPrompt: 'Just exit.',
      capabilities: ['echo-cap'],
    });

    // 3. Build the orchestrator with the real DispatchExecutor. target, workerImage,
    //    AND secrets are the executor's deploy-time config (NOT the WorkItem's) — §10.6.
    //    The inline API-key secret stages via LocalSecretStore for file:// storage
    //    (no AWS) and is log-redacted by the worker; it never touches the WorkItem.
    const orch = new PangolinOrchestrator({
      store,
      executors: {
        dispatch: new DispatchExecutor({
          client,
          target: 'local',
          workerImage: WORKER_IMAGE,
          secrets: { ANTHROPIC_API_KEY: { inline: apiKey } },
        }),
      },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 1 } },
    });

    // 4. Submit a one-item Run. The item NAMES the subagent + carries worker input.
    const runId = orch.submitRun({
      id: 'run-1',
      queue: 'default',
      items: [
        {
          id: 'edit-1',
          executor: 'dispatch',
          inputs: { subagent: 'echo', workerInput: {} },
          depends_on: [],
          resourceLocks: [],
        },
      ],
    });
    console.log(`submitted run '${runId}' (1 item) — ticking…`);

    // 5. Tick-loop until the item reaches a terminal state or we time out.
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    let status = 'pending';
    while (Date.now() < deadline) {
      const t = await orch.tick('default');
      const item = orch.getStatus(runId).find((s) => s.id === 'edit-1');
      status = item?.status ?? 'unknown';
      console.log(
        `tick: readied=${t.readied} fired=${t.fired} reconciled=${t.reconciled} | edit-1=${status}`,
      );
      if (status === 'done' || status === 'failed' || status === 'skipped') break;
      await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS));
    }

    // 6. Honest outcome (per the 2026-05-27 battle-test lesson: check, don't assume).
    if (status === 'done') {
      console.log('=== orchestrator offload OK — fire → reconcile drove the item to done ===');
    } else {
      console.error(`=== orchestrator offload ${status.toUpperCase()} ===`);
      process.exitCode = 1;
    }
  } finally {
    store.close();
    await rm(storageRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('orchestrator-offload battle-test crashed:', err);
  process.exit(1);
});
