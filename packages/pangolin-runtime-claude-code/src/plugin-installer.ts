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
  /**
   * Test/diagnostic hook for captured child output. Production callers omit it
   * (success output is discarded; failure output rides the thrown error, which
   * the worker logs through its redactor). Never written raw to fd1/fd2.
   */
  onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
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
        // F3: capture, never inherit — the merged env carries secrets and the
        // child's output must not reach the worker's fds unredacted.
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout?.on("data", (d: Buffer | string) => {
        const text = typeof d === "string" ? d : d.toString();
        out += text;
        opts.onOutput?.({ stream: "stdout", text });
      });
      child.stderr?.on("data", (d: Buffer | string) => {
        const text = typeof d === "string" ? d : d.toString();
        err += text;
        opts.onOutput?.({ stream: "stderr", text });
      });
      child.on("close", (code: number | null) => {
        if (code === 0) {
          resolve();
        } else {
          const tail = `${out}${err}`.trim();
          reject(
            new Error(
              `claude plugins install ${name} exited with code ${code}` +
                (tail ? `: ${tail}` : ""),
            ),
          );
        }
      });
      child.on("error", (e: Error) => {
        reject(
          new Error(
            `claude plugins install ${name} failed to spawn: ${e.message}`,
          ),
        );
      });
    });
  }
}
