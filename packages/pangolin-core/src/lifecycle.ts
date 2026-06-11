// Lifecycle events for a dispatch (§5.7).
//
// A dispatch is the unit of work submitted to a provider. As it moves
// through the system, the runtime emits a discriminated-union event for
// each state transition. Telemetry hooks (see `./telemetry.ts`) consume
// this stream.
//
// The six kinds form a closed taxonomy:
//   - `dispatch.accepted`     — request validated, capability refs resolved
//   - `dispatch.started`      — provider has actually started the work
//   - `dispatch.finished`     — terminal: completed with an exit code
//   - `dispatch.needs_input`  — paused awaiting external input (see ADR-0008)
//   - `dispatch.failed`       — terminal: aborted with a reason string
//   - `dispatch.cancelled`    — terminal: cancelled by caller
//
// `at` is an ISO-8601 timestamp; `durationMs` is wall-clock duration from
// worker start (`runWorker` entry, which slightly precedes
// `dispatch.started`) to the event in question.

import type { CapabilityRef } from './refs.js';

/**
 * Forward-reference placeholder for the resolved capability bundle that
 * accompanies an accepted dispatch. The shape is owned by `./refs.ts`
 * (created by the concurrent `task-core-utilities-types`); refining this
 * alias is the job of `task-core-dispatch-and-result-types`.
 */
export type ResolvedRefs = CapabilityRef[];

export type LifecycleEvent =
  | {
      kind: 'dispatch.accepted';
      dispatchId: string;
      target: string;
      resolved: ResolvedRefs;
      at: string;
    }
  | {
      kind: 'dispatch.started';
      dispatchId: string;
      providerTaskId: string;
      at: string;
    }
  | {
      kind: 'dispatch.finished';
      dispatchId: string;
      exitCode: number;
      durationMs: number;
      at: string;
    }
  | {
      kind: 'dispatch.needs_input';
      dispatchId: string;
      durationMs: number;
      at: string;
    }
  | {
      kind: 'dispatch.failed';
      dispatchId: string;
      reason: string;
      at: string;
    }
  | {
      kind: 'dispatch.cancelled';
      dispatchId: string;
      at: string;
    };
