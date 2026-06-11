// pangolin-worker: channel-loader (§6.8).
//
// Reads `pangolin-channel.json` from the post-overlay workspace, resolves the
// named channel adapter from `<adaptersRoot>/<adapterName>/index.js`,
// constructs it, and starts the subscription as a fire-and-forget background
// task. Each received message is appended as one JSONL line to
// `<workspaceDir>/.pangolin/channel/inbox.jsonl`.
//
// Returns a `ChannelHandle` with a `stop()` method that the entrypoint calls
// during teardown. `stop()` signals the iterator (via its optional `return()`
// hook) and waits up to 10s for the background loop to finish.
//
// Per §6.8: adapter failures during iteration must NOT propagate or fail the
// dispatch — they are logged and swallowed. A missing manifest yields `null`
// so the entrypoint can no-op cleanly when channels are not configured.

import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelMessage,
} from "@quarry-systems/pangolin-core";

export interface ChannelHandle {
  /** Stop the subscription and await cleanup (bounded at 10s per §6.8). */
  stop(): Promise<void>;
}

export interface LoadChannelOpts {
  workspaceDir: string;
  /** Override the adapters root for testing. Default: '/opt/pangolin/adapters'. */
  adaptersRoot?: string;
}

interface ChannelManifest {
  adapter: string;
  channel: string;
  opts?: Record<string, unknown>;
}

const STOP_TIMEOUT_MS = 10_000;

export async function loadChannelIfPresent(
  opts: LoadChannelOpts,
): Promise<ChannelHandle | null> {
  const manifestPath = join(opts.workspaceDir, "pangolin-channel.json");
  try {
    await access(manifestPath);
  } catch {
    return null;
  }

  const cfg = JSON.parse(
    await readFile(manifestPath, "utf-8"),
  ) as ChannelManifest;

  const adapter = await loadChannelAdapter(
    cfg.adapter,
    opts.adaptersRoot ?? "/opt/pangolin/adapters",
  );

  const channelDir = join(opts.workspaceDir, ".pangolin", "channel");
  await mkdir(channelDir, { recursive: true });
  const inboxPath = join(channelDir, "inbox.jsonl");

  const subscribeConfig: ChannelConfig = {
    channel: cfg.channel,
    opts: cfg.opts,
  };
  const iterable = adapter.subscribe(subscribeConfig);
  const iterator = iterable[Symbol.asyncIterator]();

  let stopped = false;
  // Fire-and-forget background drain — the promise is intentionally not
  // awaited or retained; `stopped` (closed over by stop()) ends the loop.
  void (async () => {
    while (!stopped) {
      let next;
      try {
        next = await iterator.next();
      } catch (err) {
        // §6.8 — adapter failure does not fail dispatch; log only.
        // eslint-disable-next-line no-console
        console.error(
          `pangolin-worker: channel adapter ${cfg.adapter} errored: ${String(err)}`,
        );
        return;
      }
      if (next.done) return;
      const msg = next.value as ChannelMessage;
      try {
        await appendFile(inboxPath, JSON.stringify(msg) + "\n");
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `pangolin-worker: failed to append channel message to ${inboxPath}: ${String(err)}`,
        );
        // Keep looping — a single write failure should not silently
        // terminate the subscription either.
      }
    }
  })().catch((err) => {
    // Defensive — the inner loop already catches, but if anything escapes
    // (e.g. a bad iterable that throws synchronously from Symbol.asyncIterator
    // delegation), still swallow per §6.8.
    // eslint-disable-next-line no-console
    console.error(
      `pangolin-worker: channel loop crashed for ${cfg.adapter}: ${String(err)}`,
    );
  });

  return {
    stop: async () => {
      stopped = true;
      // Bounded cleanup: ask the iterator to terminate (so any pending
      // `next()` settles), and race that against the 10s ceiling. We do not
      // additionally await the loop — once return() resolves, the iterator
      // has agreed to stop and the loop will exit on its own; any in-flight
      // append is best-effort. This keeps teardown prompt for well-behaved
      // adapters while still capping pathological ones at STOP_TIMEOUT_MS.
      const cleanup = (async () => {
        if (typeof iterator.return === "function") {
          try {
            await iterator.return();
          } catch {
            // ignore — best-effort cleanup
          }
        }
      })();
      await Promise.race([
        cleanup,
        new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
      ]);
    },
  };
}

async function loadChannelAdapter(
  name: string,
  adaptersRoot: string,
): Promise<ChannelAdapter> {
  const adapterDir = join(adaptersRoot, name);
  try {
    await access(adapterDir);
  } catch {
    throw new Error(
      `pangolin-worker: channel adapter ${name} not found at ${adapterDir}`,
    );
  }
  const entryPath = join(adapterDir, "index.js");
  const mod = (await import(pathToFileURL(entryPath).href)) as {
    default?: unknown;
    createAdapter?: unknown;
  };
  const factory = mod.default ?? mod.createAdapter;
  if (typeof factory !== "function") {
    throw new Error(
      `pangolin-worker: channel adapter ${name} at ${entryPath} does not export a default factory`,
    );
  }
  const adapter = (await (factory as () => unknown)()) as ChannelAdapter;
  if (
    !adapter ||
    typeof adapter.name !== "string" ||
    typeof adapter.subscribe !== "function"
  ) {
    throw new Error(
      `pangolin-worker: channel adapter ${name} did not return a valid ChannelAdapter (missing name or subscribe())`,
    );
  }
  return adapter;
}
