// @quarry-systems/pangolin-providers-local-docker
//
// `ComputeProvider` (§5.1) implementation backed by the local Docker daemon
// via the `dockerode` client. `run()` creates and starts a container with
// the spec's image, env, and command; `awaitExit()` blocks on Docker's wait
// API and demuxes stdout/stderr from the container log stream; `cancel()`
// sends SIGTERM with a configurable grace period and escalates to SIGKILL
// if the container has not stopped by then.
//
// Image references must be digest-pinned (`image@sha256:...`) per §7.4 unless
// the caller opts in via `allowUnpinnedImage: true` (intended for dev/test).

import Docker from 'dockerode';
import { fileURLToPath } from 'node:url';
import {
  UnpinnedImageError,
  type ComputeProvider,
  type ProviderContext,
  type TaskExit,
  type TaskHandle,
  type TaskSpec,
} from '@quarry-systems/pangolin-core';

/** Per-instance options for {@link LocalDockerProvider}. */
export interface LocalDockerProviderOpts {
  /**
   * Inject a pre-constructed Dockerode instance. Defaults to a new
   * `new Docker()` (talks to `/var/run/docker.sock` on Unix or the
   * `//./pipe/docker_engine` named pipe on Windows).
   */
  docker?: Docker;
  /**
   * Allow non-digest-pinned images (e.g. `busybox:latest`). Disabled by
   * default per §7.4. Intended for dev / local-iteration only — production
   * dispatches must always be digest-pinned.
   */
  allowUnpinnedImage?: boolean;
  /**
   * Grace period in seconds between SIGTERM and SIGKILL when `cancel()` is
   * called. Defaults to 10s (matches §6.8 cancellation contract).
   */
  sigtermGraceSeconds?: number;
  /**
   * When `spec.env.PANGOLIN_STORAGE_URI` is a `file://` URI, automatically
   * bind-mount the host directory inside the container and rewrite the env
   * var to the in-container path. This is what makes the hello-world (§4.4)
   * and the §9 acceptance dispatch succeed against `LocalStorageProvider` —
   * without it the worker can't read bundles staged on the host's tmpdir.
   * Defaults to `true`; opt out only if a capability is responsible for
   * staging the bundles via its own setup script.
   */
  autoMountFileStorage?: boolean;
  /**
   * In-container mount target used by `autoMountFileStorage`. Must be an
   * absolute Linux path. Defaults to `/pangolin/storage` so the path is
   * distinct from the worker's `/workspace` and `/opt/pangolin` trees.
   */
  storageMountTarget?: string;
  /**
   * In-container mount target for the per-dispatch secret store. When
   * `spec.env.PANGOLIN_SECRET_STORE_DIR` is set (the client staged per-dispatch
   * secrets on the host via `LocalSecretStore`), that host directory is
   * bind-mounted here and the env var is rewritten to this path so the
   * worker's `LocalSecretStore` resolves refs from inside the container.
   * Defaults to `/pangolin/secrets`.
   */
  secretStoreMountTarget?: string;
  /**
   * Additional bind mounts to apply to every container `run()`. Each entry
   * is a Dockerode `Binds` string — `<host>:<container>[:ro]`. Useful for
   * surfacing a pre-built capability bundle directory or custom worker
   * configuration without rebuilding the image.
   */
  extraBinds?: string[];
  /**
   * Deploy-time env merged into every worker container. `spec.env` wins on
   * key collision, so dispatch-time variables always take precedence over
   * provider-level defaults. Intended for static configuration such as
   * `PANGOLIN_S3_ENDPOINT` and `AWS_*` credentials that must reach the worker's
   * `process.env` at boot (the only point the worker can configure its own
   * S3 client).
   */
  extraEnv?: Record<string, string>;
  /**
   * Extra `HostConfig.ExtraHosts` entries (`<host>:<ip-or-host-gateway>`) applied
   * to every worker container. Needed when workers must reach a service on the
   * Docker host (e.g. `host.docker.internal:host-gateway` so MinIO / LocalStack on
   * the host resolve). Docker Desktop injects `host.docker.internal` automatically,
   * but native Linux daemons do not — set this for portability.
   */
  extraHosts?: string[];
}

/** Matches the `name@sha256:<64-hex>` tail. */
const IMAGE_DIGEST_RE = /@sha256:[0-9a-f]{64}$/;

/**
 * Local-Docker {@link ComputeProvider}. Dockerode is injected so the smoke
 * suite can drive the provider against a fake instance without a real
 * daemon; integration tests live in a separate task.
 */
export class LocalDockerProvider implements ComputeProvider {
  readonly name = 'local-docker';
  private readonly docker: Docker;
  private readonly allowUnpinnedImage: boolean;
  private readonly graceSeconds: number;
  private readonly autoMountFileStorage: boolean;
  private readonly storageMountTarget: string;
  private readonly secretStoreMountTarget: string;
  private readonly extraBinds: string[];
  private readonly extraEnv: Record<string, string>;
  private readonly extraHosts: string[];

  constructor(opts: LocalDockerProviderOpts = {}) {
    this.docker = opts.docker ?? new Docker();
    this.allowUnpinnedImage = opts.allowUnpinnedImage ?? false;
    this.graceSeconds = opts.sigtermGraceSeconds ?? 10;
    this.autoMountFileStorage = opts.autoMountFileStorage ?? true;
    this.storageMountTarget = opts.storageMountTarget ?? '/pangolin/storage';
    this.secretStoreMountTarget = opts.secretStoreMountTarget ?? '/pangolin/secrets';
    this.extraBinds = opts.extraBinds ?? [];
    this.extraEnv = opts.extraEnv ?? {};
    this.extraHosts = opts.extraHosts ?? [];
  }

  async run(spec: TaskSpec, _ctx: ProviderContext): Promise<TaskHandle> {
    this.assertImagePinned(spec.image);

    const { env: rewrittenEnv, binds } = this.prepareEnvAndBinds(spec);
    const env = Object.entries(rewrittenEnv).map(([k, v]) => `${k}=${v}`);
    const hostConfig: { Binds?: string[]; ExtraHosts?: string[] } = {};
    if (binds.length > 0) hostConfig.Binds = binds;
    if (this.extraHosts.length > 0) hostConfig.ExtraHosts = this.extraHosts;
    const container = await this.docker.createContainer({
      Image: spec.image,
      Env: env,
      Cmd: spec.command,
      Labels: { 'pangolin.dispatchId': spec.dispatchId },
      HostConfig: Object.keys(hostConfig).length > 0 ? hostConfig : undefined,
    });
    await container.start();
    return { providerTaskId: container.id };
  }

  /**
   * Compute the env vars + bind mounts to apply to a single `run()`.
   *
   * Auto-mount semantics: when `PANGOLIN_STORAGE_URI` is a `file://` URI and
   * `autoMountFileStorage` is enabled (the default), translate the file URI
   * to a host filesystem path via `fileURLToPath`, bind-mount it at
   * `storageMountTarget` inside the container, and rewrite the env var to
   * point at the in-container path. The conversion preserves Windows drive
   * letters (Docker Desktop translates `C:\path\to\dir` automatically when
   * passed as a Binds source).
   */
  private prepareEnvAndBinds(spec: TaskSpec): {
    env: Record<string, string>;
    binds: string[];
  } {
    const env = { ...this.extraEnv, ...spec.env }; // spec.env wins on collision
    const binds = [...this.extraBinds];
    const storageUri = env.PANGOLIN_STORAGE_URI;
    if (
      this.autoMountFileStorage &&
      storageUri &&
      storageUri.startsWith('file://')
    ) {
      let hostPath: string | null = null;
      try {
        hostPath = fileURLToPath(storageUri);
      } catch {
        hostPath = null;
      }
      if (hostPath) {
        binds.push(`${hostPath}:${this.storageMountTarget}`);
        env.PANGOLIN_STORAGE_URI = `file://${this.storageMountTarget}`;
      }
    }

    // Per-dispatch secret store: the client staged secrets on the host under
    // PANGOLIN_SECRET_STORE_DIR (a plain path, not a file:// URI). Bind-mount it
    // in and rewrite the env var so the worker's LocalSecretStore reads from
    // the in-container path. The refs themselves are path-independent
    // (`local-secret://<id>`), so only the dir view differs across the mount.
    const secretDir = env.PANGOLIN_SECRET_STORE_DIR;
    if (secretDir) {
      binds.push(`${secretDir}:${this.secretStoreMountTarget}`);
      env.PANGOLIN_SECRET_STORE_DIR = this.secretStoreMountTarget;
    }

    return { env, binds };
  }

  async awaitExit(handle: TaskHandle, _ctx: ProviderContext): Promise<TaskExit> {
    const container = this.docker.getContainer(handle.providerTaskId);

    // Block until the container reaches a terminal state. We intentionally
    // do not use `wait()`'s StatusCode as the authoritative exit code —
    // `inspect()`'s State.ExitCode is the canonical value and we read it
    // after the wait completes.
    await container.wait();

    const [logsBuf, info] = await Promise.all([
      container.logs({ stdout: true, stderr: true, follow: false }),
      container.inspect(),
    ]);

    const { stdout, stderr } = demuxDockerLogStream(logsBuf);

    return {
      exitCode: info.State.ExitCode,
      startedAt: new Date(info.State.StartedAt),
      finishedAt: new Date(info.State.FinishedAt),
      stdout,
      stderr,
    };
  }

  async cancel(handle: TaskHandle, _ctx: ProviderContext): Promise<void> {
    const container = this.docker.getContainer(handle.providerTaskId);

    try {
      await container.kill({ signal: 'SIGTERM' });
    } catch {
      // container may have already stopped — fall through to terminal-state check.
    }

    // Poll inspect() until the container is no longer Running or the grace
    // period elapses. Poll cadence is 100ms — small relative to the typical
    // grace period (default 10s) so timer-driven tests stay quick, and the
    // load on the daemon is negligible.
    const pollIntervalMs = 100;
    const deadlineMs = Date.now() + this.graceSeconds * 1000;

    while (Date.now() < deadlineMs) {
      const info = await container.inspect();
      if (!info.State.Running) {
        return;
      }
      await sleep(pollIntervalMs);
    }

    // Grace exhausted — best-effort SIGKILL. Swallow any error so cancel()
    // remains idempotent against races where the container exited between
    // the last poll and the kill.
    try {
      await container.kill({ signal: 'SIGKILL' });
    } catch {
      // already stopped — nothing to do.
    }
  }

  private assertImagePinned(image: string): void {
    if (this.allowUnpinnedImage) return;
    if (!IMAGE_DIGEST_RE.test(image)) {
      throw new UnpinnedImageError(image);
    }
  }
}

/**
 * Demultiplex Docker's combined log stream. When `follow: false` and
 * `stdout`+`stderr` are both requested on a non-TTY container, dockerode
 * returns a Buffer of 8-byte-headed frames:
 *
 *   byte 0:    stream type (1 = stdout, 2 = stderr, 0 = stdin)
 *   bytes 1-3: padding
 *   bytes 4-7: payload size (big-endian uint32)
 *   bytes 8+:  payload of declared size
 *
 * On TTY-mode containers Docker emits a raw stream without headers; this
 * helper tolerates that by detecting an unparseable frame and falling back
 * to treating the entire buffer as stdout.
 */
function demuxDockerLogStream(buf: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let offset = 0;

  while (offset + 8 <= buf.length) {
    const type = buf.readUInt8(offset);
    const size = buf.readUInt32BE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > buf.length || (type !== 1 && type !== 2 && type !== 0)) {
      // Malformed / TTY stream — bail out and treat the rest as stdout.
      out.push(buf.subarray(offset));
      offset = buf.length;
      break;
    }
    const payload = buf.subarray(payloadStart, payloadEnd);
    if (type === 2) {
      err.push(payload);
    } else {
      out.push(payload);
    }
    offset = payloadEnd;
  }

  return {
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8'),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
