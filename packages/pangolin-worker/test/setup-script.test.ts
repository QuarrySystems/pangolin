import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runSetupScriptIfPresent,
  SetupScriptError,
} from "../src/setup-script.js";

describe("runSetupScriptIfPresent", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "setup-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when pangolin-setup.sh is absent", async () => {
    const res = await runSetupScriptIfPresent({
      workspaceDir: dir,
      env: {},
      timeoutSeconds: 5,
    });
    expect(res).toBeNull();
  });

  // The execution-based tests below require /bin/bash. Node on Windows
  // cannot spawn POSIX shells, so we gate them.
  const itPosix = process.platform === "win32" ? it.skip : it;

  itPosix("returns SetupScriptResult with exitCode 0 on success", async () => {
    await writeFile(
      join(dir, "pangolin-setup.sh"),
      "#!/bin/bash\necho hello-stdout\necho hello-stderr 1>&2\nexit 0\n",
    );
    await chmod(join(dir, "pangolin-setup.sh"), 0o755);
    const res = await runSetupScriptIfPresent({
      workspaceDir: dir,
      env: {},
      timeoutSeconds: 5,
    });
    expect(res).not.toBeNull();
    expect(res!.exitCode).toBe(0);
    expect(res!.stdout).toContain("hello-stdout");
    expect(res!.stderr).toContain("hello-stderr");
    expect(res!.durationMs).toBeGreaterThanOrEqual(0);
  });

  itPosix("throws SetupScriptError on non-zero exit", async () => {
    await writeFile(
      join(dir, "pangolin-setup.sh"),
      "#!/bin/bash\necho oops 1>&2\nexit 1\n",
    );
    await chmod(join(dir, "pangolin-setup.sh"), 0o755);
    await expect(
      runSetupScriptIfPresent({
        workspaceDir: dir,
        env: {},
        timeoutSeconds: 5,
      }),
    ).rejects.toBeInstanceOf(SetupScriptError);
  });

  itPosix(
    "SetupScriptError on non-zero exit carries result with stderr captured",
    async () => {
      await writeFile(
        join(dir, "pangolin-setup.sh"),
        "#!/bin/bash\necho bad-stderr 1>&2\nexit 2\n",
      );
      await chmod(join(dir, "pangolin-setup.sh"), 0o755);
      try {
        await runSetupScriptIfPresent({
          workspaceDir: dir,
          env: {},
          timeoutSeconds: 5,
        });
        throw new Error("expected SetupScriptError");
      } catch (e) {
        expect(e).toBeInstanceOf(SetupScriptError);
        const err = e as SetupScriptError;
        expect(err.result.exitCode).toBe(2);
        expect(err.result.stderr).toContain("bad-stderr");
      }
    },
  );

  itPosix(
    "kills the child and rejects with SetupScriptError (exitCode -1) on timeout",
    async () => {
      // Sleep 5s but timeout in 1s.
      await writeFile(
        join(dir, "pangolin-setup.sh"),
        "#!/bin/bash\nsleep 5\nexit 0\n",
      );
      await chmod(join(dir, "pangolin-setup.sh"), 0o755);
      const start = Date.now();
      try {
        await runSetupScriptIfPresent({
          workspaceDir: dir,
          env: {},
          timeoutSeconds: 1,
        });
        throw new Error("expected SetupScriptError due to timeout");
      } catch (e) {
        expect(e).toBeInstanceOf(SetupScriptError);
        const err = e as SetupScriptError;
        expect(err.result.exitCode).toBe(-1);
      }
      // Should have come back roughly at the timeout, well before 5s.
      expect(Date.now() - start).toBeLessThan(4000);
    },
    10_000,
  );

  itPosix("passes env to the spawned shell", async () => {
    await writeFile(
      join(dir, "pangolin-setup.sh"),
      '#!/bin/bash\necho "GOT=$PANGOLIN_TEST_VAR"\nexit 0\n',
    );
    await chmod(join(dir, "pangolin-setup.sh"), 0o755);
    const res = await runSetupScriptIfPresent({
      workspaceDir: dir,
      env: { PANGOLIN_TEST_VAR: "from-env", PATH: process.env.PATH ?? "" },
      timeoutSeconds: 5,
    });
    expect(res).not.toBeNull();
    expect(res!.stdout).toContain("GOT=from-env");
  });
});
