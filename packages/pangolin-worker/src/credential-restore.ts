// pangolin-worker: restore the handed-off credential environment after execve.
//
// Half two of C1'-restore (spec §7.3). The container entrypoint captures the
// worker's environment, writes it to an already-unlinked file, and `exec`s the
// worker with a CLEAN environment plus an inherited fd. This module reads that
// fd back and restores the values into `process.env`.
//
// Why that works: `/proc/<pid>/environ` exposes the region fixed at `execve`.
// Values written into `process.env` afterwards live in the process heap and are
// NOT visible there. A same-uid agent reading `/proc/<worker-pid>/environ` — the
// finding this exists to close — therefore sees the clean environment, while the
// AWS SDK's own credential chain and `bundle-fetcher.ts`'s direct `process.env`
// reads see the restored values. Both halves were measured in the real image
// before this was designed.

import { readFileSync } from 'node:fs';

export class CredentialRestoreError extends Error {}

/**
 * Parse a NUL-separated `KEY=VALUE` block.
 *
 * NUL framing, not newline: `PANGOLIN_BUNDLE_REFS_JSON` carries arbitrary JSON
 * whose values may contain literal newlines, so newline framing would corrupt
 * it. This is the same framing `/proc/<pid>/environ` itself uses.
 *
 * A trailing NUL is normal and yields no empty entry.
 */
export function parseEnvPayload(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of raw.split('\0')) {
    if (entry.length === 0) continue;
    const eq = entry.indexOf('=');
    // `eq === 0` is an empty key, which would silently create a junk entry;
    // `eq < 0` is not a KEY=VALUE pair at all. Both are malformed input, and
    // this payload is written by our own entrypoint — so either means the
    // hand-off is broken, not that the caller passed something odd.
    if (eq <= 0) {
      throw new CredentialRestoreError(`malformed entry (no KEY=): ${entry.slice(0, 24)}`);
    }
    // Values may themselves contain '=' — split on the FIRST one only.
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

/**
 * Restore the handed-off environment into `process.env`.
 *
 * Acts on the REAL process environment, never a threaded `env` object — that is
 * the only thing the AWS SDK's credential chain and `bundle-fetcher.ts`'s direct
 * `process.env` reads observe. A test asserting against a synthetic `env` object
 * would prove nothing about the mechanism.
 *
 * No fd => no hand-off => leave `process.env` alone. That is today's behaviour,
 * so an image running the old entrypoint keeps working unchanged.
 *
 * An fd that cannot be read is a FAILURE, never a silent fallback. A quiet
 * degrade walks the credential chain into an IMDS timeout on the POST-agent
 * upload path — where the work is already done and about to be lost. Failing
 * loudly at boot is strictly better than losing a completed dispatch (spec §7.5).
 *
 * @returns the names of the keys restored, in payload order.
 */
export function restoreCredentials(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.PANGOLIN_CRED_FD;
  if (raw === undefined) return [];

  const fd = Number(raw);
  if (!Number.isInteger(fd) || fd < 0) {
    throw new CredentialRestoreError(`PANGOLIN_CRED_FD is not a valid fd: ${raw}`);
  }

  let payload: string;
  try {
    payload = readFileSync(fd, 'utf8');
  } catch (err) {
    throw new CredentialRestoreError(`could not read fd ${fd}: ${(err as Error).message}`);
  }

  const parsed = parseEnvPayload(payload);
  for (const [k, v] of Object.entries(parsed)) env[k] = v;

  // Must not survive: an inherited PANGOLIN_CRED_FD would hand the agent a
  // readable pointer to the very payload this mechanism exists to hide.
  delete env.PANGOLIN_CRED_FD;

  return Object.keys(parsed);
}
