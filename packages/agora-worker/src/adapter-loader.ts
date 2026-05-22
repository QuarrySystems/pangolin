// agora-worker: runtime adapter loader (§5.8).
//
// Locates a `RuntimeAdapter` implementation under
// `<adaptersRoot>/<name>/index.js` (default root `/opt/agora/adapters`)
// and constructs it via the module's default factory export (or, as a
// fallback, a named `createAdapter` export). The factory may be sync
// or async; its return value must satisfy the minimal `RuntimeAdapter`
// shape (a `name` string and an `invoke()` function).
//
// Called at worker boot after env parsing — this loader is the seam
// that lets the worker stay runtime-agnostic. A missing or malformed
// adapter throws a clear error so the upstream dispatch can fail with
// `reason: 'worker-failed'`.

import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RuntimeAdapter } from "@quarry-systems/agora-core";

export interface AdapterLoaderOpts {
  /** Override the adapters root for testing. Default: '/opt/agora/adapters'. */
  adaptersRoot?: string;
}

export async function loadRuntimeAdapter(
  name: string,
  opts: AdapterLoaderOpts = {},
): Promise<RuntimeAdapter> {
  const root = opts.adaptersRoot ?? "/opt/agora/adapters";
  const adapterDir = join(root, name);

  try {
    await access(adapterDir);
  } catch {
    throw new Error(
      `agora-worker: adapter ${name} not found at ${adapterDir} — check AGORA_RUNTIME_ADAPTER and worker image bundling`,
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
      `agora-worker: adapter ${name} at ${entryPath} does not export a default factory`,
    );
  }

  const adapter = (await (factory as () => unknown)()) as RuntimeAdapter;
  if (!adapter || !adapter.name || typeof adapter.invoke !== "function") {
    throw new Error(
      `agora-worker: adapter ${name} did not return a valid RuntimeAdapter (missing name or invoke())`,
    );
  }
  return adapter;
}
