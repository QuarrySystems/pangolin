// Bundled default implementations (§5.2 / §5.6 / §5.7).
//
// Three lightweight defaults that ship with `pangolin-client` so callers can
// stand up a working dispatch path without authoring their own sinks,
// credential providers, or telemetry hooks:
//
//   - `StdoutResultSink` — the default `ResultSink`. Normalizes a
//     provider's `TaskExit` into a `DispatchResult`, truncates stdout at
//     4 MiB and stderr at 256 KiB (per §6.7), and writes a single-line
//     JSON summary to `process.stdout` so an outer harness can stream
//     dispatch completion without needing to parse the full body.
//
//   - `NoopCredentialProvider` — the credential provider used by
//     `LocalDockerProvider` in local-dev configs where no real secret
//     material is needed. Resolves to `{ kind: 'none' }`.
//
//   - `NoopTelemetryHook` — drops every `LifecycleEvent`. Used when no
//     telemetry integration is wired into the runtime.

import type {
  CredentialProvider,
  DispatchResult,
  LifecycleEvent,
  ResolvedCredentials,
  ResultSink,
  SinkContext,
  TaskExit,
  TaskHandle,
  TelemetryHook,
} from '@quarry-systems/pangolin-core';

const STDOUT_CAP_BYTES = 4 * 1024 * 1024; // 4 MiB
const STDERR_CAP_BYTES = 256 * 1024; // 256 KiB

/** Canonical DispatchResult.failure reasons (mirrors the union in pangolin-core). */
const FAILURE_REASONS = [
  'worker-failed',
  'provider-failed',
  'timeout',
  'cancelled',
  'fetch-failed',
  'integrity-failed',
] as const;

/**
 * Default `ResultSink`. Normalizes a `TaskExit` into a `DispatchResult`,
 * truncating large stdout/stderr with an explicit marker and writing a
 * single-line JSON completion summary to `process.stdout`.
 */
export class StdoutResultSink implements ResultSink {
  readonly name = 'stdout';

  async collect(
    _handle: TaskHandle,
    exit: TaskExit,
    ctx: SinkContext,
  ): Promise<DispatchResult> {
    const result: DispatchResult = {
      dispatchId: ctx.dispatchId,
      exitCode: exit.exitCode,
      stdout: truncate(exit.stdout, STDOUT_CAP_BYTES, '4 MiB'),
      stderr: truncate(exit.stderr, STDERR_CAP_BYTES, '256 KiB'),
      durationMs: exit.finishedAt.getTime() - exit.startedAt.getTime(),
      resolved: ctx.resolved,
    };

    // Attribute an infrastructural failure. Per the DispatchResult contract,
    // `failure` is populated only when the provider reports `providerFailureReason`
    // (image-pull-fail, quota, timeout, …); an application-level non-zero exit
    // (no providerFailureReason) is reported via `exitCode` alone. A reason that
    // is already one of the canonical reasons passes through; anything else is
    // bucketed as 'provider-failed', with the raw string preserved in `detail`.
    if (exit.providerFailureReason !== undefined) {
      const raw = exit.providerFailureReason;
      result.failure = {
        reason: (FAILURE_REASONS as readonly string[]).includes(raw)
          ? (raw as NonNullable<DispatchResult['failure']>['reason'])
          : 'provider-failed',
        detail: raw,
      };
    }

    // Scan the worker's structured-log stream for a clean needs_input pause.
    // Per pangolin-worker (entrypoint.ts step 13), a valid sentinel logs a JSON
    // line {kind:'dispatch.needs_input', dispatchId, question} and the worker
    // exits 0. Populating result.needsInput lets an overnight orchestrator
    // detect-and-continue (log + skip) without grepping stdout itself. Failure
    // takes precedence: failure has providerFailureReason; needs_input has
    // exit 0 + sentinel — disjoint by design.
    if (!result.failure) {
      const needs = findNeedsInputInStdout(exit.stdout);
      if (needs) result.needsInput = needs;
    }

    process.stdout.write(
      JSON.stringify(
        result.failure
          ? {
              kind: 'dispatch.failed',
              dispatchId: ctx.dispatchId,
              exitCode: exit.exitCode,
              reason: result.failure.reason,
            }
          : result.needsInput
            ? {
                kind: 'dispatch.needs_input',
                dispatchId: ctx.dispatchId,
                exitCode: exit.exitCode,
                question: result.needsInput.question,
              }
            : {
                kind: 'dispatch.finished',
                dispatchId: ctx.dispatchId,
                exitCode: exit.exitCode,
              },
      ) + '\n',
    );
    return result;
  }
}

/**
 * Scan the worker's structured-log stream for a terminal `dispatch.needs_input`
 * event. The worker (pangolin-worker entrypoint.ts step 13) logs a JSON line of
 * shape `{kind:'dispatch.needs_input', dispatchId, question}` then exits 0 on
 * a clean sentinel pause. Non-JSON lines and parse errors are silently skipped
 * — the stream is structured-log, but defensive parsing keeps us robust to
 * any non-JSON output that may sneak in.
 */
function findNeedsInputInStdout(stdout: string): { question: string } | undefined {
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue; // fast-path skip non-JSON
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      obj !== null &&
      typeof obj === 'object' &&
      (obj as { kind?: unknown }).kind === 'dispatch.needs_input' &&
      typeof (obj as { question?: unknown }).question === 'string' &&
      (obj as { question: string }).question.length > 0
    ) {
      return { question: (obj as { question: string }).question };
    }
  }
  return undefined;
}

/**
 * Truncate `s` to fit within `capBytes` UTF-8 bytes, appending a marker
 * describing the cap (`'4 MiB'`, `'256 KiB'`). When the input already
 * fits, the original string is returned unchanged.
 */
function truncate(s: string, capBytes: number, capLabel: string): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.byteLength <= capBytes) return s;
  const marker = `\n...truncated at ${capLabel}. Full output not retained.\n`;
  const markerBytes = new TextEncoder().encode(marker);
  const room = Math.max(0, capBytes - markerBytes.byteLength);
  // `TextDecoder` with default `fatal: false` discards a trailing partial
  // multi-byte sequence at the boundary rather than throwing.
  const head = new TextDecoder('utf-8').decode(bytes.slice(0, room));
  return head + marker;
}

/**
 * Default `CredentialProvider`. Resolves to `{ kind: 'none' }`; used by
 * `LocalDockerProvider` in local-dev configs.
 */
export class NoopCredentialProvider implements CredentialProvider {
  readonly name = 'none';

  async resolve(): Promise<ResolvedCredentials> {
    return { kind: 'none' };
  }
}

/**
 * Default `TelemetryHook`. Drops every event. Used when no telemetry
 * integration is wired.
 */
export class NoopTelemetryHook implements TelemetryHook {
  readonly name = 'noop';

  emit(_event: LifecycleEvent): void {
    /* drop */
  }
}
