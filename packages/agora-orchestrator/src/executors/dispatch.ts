import type { AgoraClient, InFlightDispatch } from '@quarry-systems/agora-client';
import type { DispatchWork } from '@quarry-systems/agora-core';
import type { Executor, ExecutionResult, WorkItem } from '../contracts/index.js';

export interface DispatchExecutorOptions {
  /** A fully-wired AgoraClient (namespace, compute, credentials, storage). */
  client: AgoraClient;
  /** Deploy-time: which AgoraClient target to dispatch against (NOT from WorkItem inputs). */
  target: string;
  /** Deploy-time: digest-pinned worker image (NOT from WorkItem inputs). */
  workerImage: string;
  /**
   * Deploy-time secrets attached to EVERY dispatch — staged via the client's
   * secret path (LocalSecretStore for file:// storage, AWS otherwise) and
   * log-redacted by the worker. Configured here (privileged, e.g. from
   * `process.env` in agora.config.mjs), NEVER carried in a WorkItem's inputs:
   * a run-time/MCP-submitted item must not supply or read secret values (§10.6).
   */
  secrets?: DispatchWork['secrets'];
}

type Settled =
  | { kind: 'exit'; exit: Awaited<ReturnType<InFlightDispatch['awaitExit']>> }
  | { kind: 'error'; error: unknown };

interface InFlightEntry {
  inflight: InFlightDispatch;
  settled: Settled | null;
}

/** First concrete Executor: runs WorkItems as agora container dispatches (spec §2). */
export class DispatchExecutor implements Executor {
  readonly id = 'dispatch';
  private readonly inflight = new Map<string, InFlightEntry>();

  constructor(private readonly opts: DispatchExecutorOptions) {}

  async fire(item: WorkItem): Promise<{ dispatchHash: string }> {
    const subagent = item.inputs.subagent;
    if (typeof subagent !== 'string' || subagent.length === 0) {
      throw new Error(`DispatchExecutor: WorkItem '${item.id}' is missing a string inputs.subagent`);
    }
    const flight = await this.opts.client.dispatch.fire({
      subagent,
      env: item.inputs.env as string | string[] | undefined,
      input: (item.inputs.workerInput as Record<string, unknown> | undefined) ?? {},
      target: this.opts.target,
      workerImage: this.opts.workerImage,
      secrets: this.opts.secrets,
    });
    const entry: InFlightEntry = { inflight: flight, settled: null };
    // Detached background await — never throws out; records terminal state for reconcile().
    void flight.awaitExit().then(
      (exit) => { entry.settled = { kind: 'exit', exit }; },
      (error) => { entry.settled = { kind: 'error', error }; },
    );
    this.inflight.set(flight.dispatchId, entry);
    return { dispatchHash: flight.dispatchId };
  }

  async reconcile(dispatchHash: string): Promise<ExecutionResult | null> {
    const entry = this.inflight.get(dispatchHash);
    if (!entry || entry.settled === null) return null; // unknown or still running
    this.inflight.delete(dispatchHash);
    if (entry.settled.kind === 'error') {
      entry.inflight.cleanup();
      return { status: 'failed', output: { error: String(entry.settled.error) } };
    }
    const result = await entry.inflight.reconcile(entry.settled.exit);
    entry.inflight.cleanup();
    return { status: result.exitCode === 0 ? 'done' : 'failed', output: result };
  }
}
