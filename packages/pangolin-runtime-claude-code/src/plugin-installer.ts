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

import { spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  armChildTimeout,
  DETACH_FOR_GROUP_KILL,
  type ChildTimeoutOptions,
} from './child-timeout.js';

export interface InstallPluginsOptions extends ChildTimeoutOptions {
  workspaceDir: string;
  env: Record<string, string>;
  claudeBin?: string;
  /**
   * Test/diagnostic hook for captured child output. Production callers omit it
   * (success output is discarded; failure output rides the thrown error, which
   * the worker logs through its redactor). Never written raw to fd1/fd2.
   */
  onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
}

export async function installPluginsFromManifest(opts: InstallPluginsOptions): Promise<void> {
  const manifestPath = join(opts.workspaceDir, 'pangolin-plugins.json');
  try {
    await access(manifestPath);
  } catch {
    return;
  }

  const raw = await readFile(manifestPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('pangolin-plugins.json must be a JSON array of plugin names');
  }
  const manifest = parsed as ReadonlyArray<string>;

  const bin = opts.claudeBin ?? 'claude';
  for (const name of manifest) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, ['plugins', 'install', name], {
        cwd: opts.workspaceDir,
        env: opts.env,
        // F3: capture, never inherit — the merged env carries secrets and the
        // child's output must not reach the worker's fds unredacted.
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group, so a timeout signals the installer's descendants
        // (package managers, fetch helpers) and not just the direct child.
        detached: DETACH_FOR_GROUP_KILL,
      });
      let out = '';
      let err = '';
      child.stdout?.on('data', (d: Buffer | string) => {
        const text = typeof d === 'string' ? d : d.toString();
        out += text;
        opts.onOutput?.({ stream: 'stdout', text });
      });
      child.stderr?.on('data', (d: Buffer | string) => {
        const text = typeof d === 'string' ? d : d.toString();
        err += text;
        opts.onOutput?.({ stream: 'stderr', text });
      });
      // The bound applies per plugin, not across the manifest: installs run
      // sequentially, and a per-install bound is what the emitted
      // PANGOLIN_PLUGIN_INSTALL_TIMEOUT_SECONDS describes.
      const timeout = armChildTimeout(child, `claude plugins install ${name}`, opts);

      let settled = false;

      child.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        timeout.disarm();
        const tail = `${out}${err}`.trim();
        if (timeout.timedOut()) {
          reject(new Error(`${timeout.reason()!}${tail ? `: ${tail}` : ''}`));
        } else if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `claude plugins install ${name} exited with code ${code}` + (tail ? `: ${tail}` : ''),
            ),
          );
        }
      });

      // Timeout-path safety net — see the equivalent in claude-spawn.ts. A
      // surviving descendant holding the pipe would otherwise stop 'close'
      // from ever firing, hanging the install we just tried to bound.
      child.on('exit', () => {
        if (settled || !timeout.timedOut()) return;
        settled = true;
        timeout.disarm();
        const tail = `${out}${err}`.trim();
        reject(new Error(`${timeout.reason()!}${tail ? `: ${tail}` : ''}`));
      });

      child.on('error', (e: Error) => {
        if (settled) return;
        settled = true;
        timeout.disarm();
        reject(new Error(`claude plugins install ${name} failed to spawn: ${e.message}`));
      });
    });
  }
}
