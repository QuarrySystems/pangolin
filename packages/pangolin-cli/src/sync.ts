// Shared sync-loop helper.
//
// Both `subagent sync` and `capabilities sync` walk a list of provider-
// produced items and either register each (and print its content hash) or
// preview what *would* be registered when `--dry-run` is set. This helper
// captures that loop once so the cmd-* call sites stay thin and any output-
// format change (e.g. switching to JSON-lines) lives in exactly one place.

export interface NamedRef {
  name: string;
  contentHash: string;
}

export interface RunSyncOpts<T extends { name: string }> {
  /** Human-readable label printed before each item ("subagent", "capability"). */
  kind: string;
  /** Items produced by a SyncProvider. */
  items: T[];
  /** When true, print what would happen and skip registration. */
  dryRun: boolean;
  /** Register a single item with the PangolinClient and return its ref. */
  register: (item: T) => Promise<NamedRef>;
}

export async function runSync<T extends { name: string }>(opts: RunSyncOpts<T>): Promise<void> {
  for (const item of opts.items) {
    if (opts.dryRun) {
      console.log(`(dry-run) ${opts.kind} ${item.name}`);
      continue;
    }
    const ref = await opts.register(item);
    console.log(`synced ${opts.kind} ${ref.name}\t${ref.contentHash}`);
  }
}
