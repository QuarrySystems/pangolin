/**
 * Pure frame-dedup helper for run-view rendering.
 *
 * No TTY code lives here — callers own cursor control (ANSI cursor-up + clear-height + reprint).
 * Deliberate placement beside render.ts so the driver (examples/dogfood-gated) can import it
 * without pulling in pangolin-cli.
 */

/**
 * Returns the frame to emit, or null when identical to the previous frame.
 *
 * Pass `undefined` as `prev` on the first frame — always returns `next` in that case.
 */
export function nextFrame(prev: string[] | undefined, next: string[]): string[] | null {
  if (prev !== undefined && prev.length === next.length && prev.every((l, i) => l === next[i])) {
    return null;
  }
  return next;
}
