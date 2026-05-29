// Local file-backed adapter for the SecretStore (ENVStore) contract.
//
// Dev / `LocalDockerProvider` counterpart to `AwsSecretStore`. Each staged
// secret is written as its own file under `dir` (mode 0600), with a sidecar
// `.meta.json` recording tags + ttl so `cleanupByTag` can sweep a dispatch's
// secrets. The ref is `local-secret://<id>`; `resolve` reads the file back,
// so resolution works across process boundaries (the worker constructs its
// own store over the same `dir`) without shared in-memory state.
//
// SECURITY NOTE: unlike the registry's `StorageProvider` (which only ever
// holds secret REFERENCES), this store holds plaintext secret VALUES on
// disk. `dir` MUST be a private scratch directory — never the bind-mounted
// registry/storage root, and never a path that gets persisted or shipped.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  SecretStore,
  StageSecretArgs,
  StagedSecret,
} from "@quarry-systems/agora-core";

const REF_SCHEME = "local-secret://";

export interface LocalSecretStoreOpts {
  /** Private scratch directory holding per-secret files + sidecar metadata. */
  dir: string;
}

interface SecretMeta {
  name: string;
  ttlSeconds: number;
  tags: Record<string, string>;
  stagedAt: string;
}

export class LocalSecretStore implements SecretStore {
  readonly name = "local-file";
  private readonly dir: string;

  constructor(opts: LocalSecretStoreOpts) {
    this.dir = opts.dir;
  }

  async stage(args: StageSecretArgs): Promise<StagedSecret> {
    await mkdir(this.dir, { recursive: true });
    const id = randomUUID();
    const meta: SecretMeta = {
      name: args.name,
      ttlSeconds: args.ttlSeconds,
      tags: args.tags ?? {},
      stagedAt: new Date().toISOString(),
    };
    // Value first, then metadata: a crashed stage leaves an orphan value
    // file (swept by ttl) rather than a meta pointing at a missing value.
    await writeFile(this.valuePath(id), args.value, { mode: 0o600 });
    await writeFile(this.metaPath(id), JSON.stringify(meta), { mode: 0o600 });
    return { ref: `${REF_SCHEME}${id}`, ttlSeconds: args.ttlSeconds };
  }

  async resolve(ref: string): Promise<string> {
    const id = this.idFromRef(ref);
    try {
      return await readFile(this.valuePath(id), "utf8");
    } catch (err) {
      throw new Error(
        `LocalSecretStore: cannot resolve ${ref}: ${(err as Error).message}`,
      );
    }
  }

  async cleanupByTag(tagKey: string, tagValue: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return; // dir never created — nothing to clean
    }
    for (const entry of entries) {
      if (!entry.endsWith(".meta.json")) continue;
      const id = entry.slice(0, -".meta.json".length);
      let meta: SecretMeta;
      try {
        meta = JSON.parse(await readFile(join(this.dir, entry), "utf8")) as SecretMeta;
      } catch {
        continue;
      }
      if (meta.tags?.[tagKey] === tagValue) {
        await rm(this.valuePath(id), { force: true });
        await rm(this.metaPath(id), { force: true });
      }
    }
  }

  private idFromRef(ref: string): string {
    if (!ref.startsWith(REF_SCHEME)) {
      throw new Error(`LocalSecretStore: not a local-secret ref: ${ref}`);
    }
    return ref.slice(REF_SCHEME.length);
  }

  private valuePath(id: string): string {
    return join(this.dir, `${id}.secret`);
  }

  private metaPath(id: string): string {
    return join(this.dir, `${id}.meta.json`);
  }
}
