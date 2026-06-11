// Reads `pangolin-plugins.json` from a workspace (post-overlay) and invokes
// `claude plugins install <name>` for each entry, sequentially, before the
// runtime spawn (§5.8).
//
// Manifest contract: a JSON array of plugin-name strings. Absent file = no-op.
// Non-array shapes throw. Non-zero exit from any install throws fail-fast
// with the offending plugin name in the message.
//
// `claudeBin` is injectable so tests (and exotic deployments) can point at
// a stub binary instead of the real CLI.

import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

export interface InstallPluginsOptions {
  workspaceDir: string;
  env: Record<string, string>;
  claudeBin?: string;
}

export async function installPluginsFromManifest(
  opts: InstallPluginsOptions,
): Promise<void> {
  const manifestPath = join(opts.workspaceDir, "pangolin-plugins.json");
  try {
    await access(manifestPath);
  } catch {
    return;
  }

  const raw = await readFile(manifestPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(
      "pangolin-plugins.json must be a JSON array of plugin names",
    );
  }
  const manifest = parsed as ReadonlyArray<string>;

  const bin = opts.claudeBin ?? "claude";
  for (const name of manifest) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, ["plugins", "install", name], {
        cwd: opts.workspaceDir,
        env: opts.env,
        stdio: "inherit",
      });
      child.on("exit", (code: number | null) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `claude plugins install ${name} exited with code ${code}`,
            ),
          );
        }
      });
      child.on("error", (err: Error) => {
        reject(
          new Error(
            `claude plugins install ${name} failed to spawn: ${err.message}`,
          ),
        );
      });
    });
  }
}
