// Bundled default implementations (§5.2 / §5.6 / §5.7).
//
// Three lightweight defaults that ship with `agora-client` so callers can
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
} from '@quarry-systems/agora-core';

const STDOUT_CAP_BYTES = 4 * 1024 * 1024; // 4 MiB
const STDERR_CAP_BYTES = 256 * 1024; // 256 KiB

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
    process.stdout.write(
      JSON.stringify({
        kind: 'dispatch.finished',
        dispatchId: ctx.dispatchId,
        exitCode: exit.exitCode,
      }) + '\n',
    );
    return result;
  }
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
