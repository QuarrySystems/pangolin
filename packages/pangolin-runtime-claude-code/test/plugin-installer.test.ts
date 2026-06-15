import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

// Mock node:child_process so tests don't depend on the `claude` CLI being
// installed. The mock factory must be self-contained (no closures over
// test-scope vars) due to vitest hoisting.
vi.mock("node:child_process", () => {
  const calls: Array<{ bin: string; args: string[]; stdio: unknown }> = [];
  const config = { nextExitCode: 0, nextStdout: "", nextStderr: "" };
  function spawn(bin: string, args: string[], opts: { stdio?: unknown; cwd?: string; env?: Record<string, string> } = {}) {
    calls.push({ bin, args, stdio: opts.stdio });
    const ee = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    setImmediate(() => {
      if (config.nextStdout) ee.stdout.emit("data", Buffer.from(config.nextStdout));
      if (config.nextStderr) ee.stderr.emit("data", Buffer.from(config.nextStderr));
      ee.emit("exit", config.nextExitCode);
    });
    return ee;
  }
  return {
    spawn,
    // Test-only escape hatches exposed on the mock module.
    __calls: calls,
    __config: config,
    __reset: () => {
      calls.length = 0;
      Object.assign(config, { nextExitCode: 0, nextStdout: "", nextStderr: "" });
    },
  };
});

import { installPluginsFromManifest } from "../src/plugin-installer.js";
import * as cp from "node:child_process";

type MockCpModule = typeof cp & {
  __calls: Array<{
    bin: string;
    args: ReadonlyArray<string>;
    stdio: unknown;
  }>;
  __config: { nextExitCode: number; nextStdout: string; nextStderr: string };
  __reset: () => void;
};

const cpMock = cp as unknown as MockCpModule;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plugins-"));
  cpMock.__reset();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("installPluginsFromManifest", () => {
  it("is a no-op when pangolin-plugins.json is absent", async () => {
    await expect(
      installPluginsFromManifest({ workspaceDir: dir, env: {} }),
    ).resolves.toBeUndefined();
    expect(cpMock.__calls).toHaveLength(0);
  });

  it("invokes `claude plugins install <name>` for each entry in declared order", async () => {
    await writeFile(
      join(dir, "pangolin-plugins.json"),
      JSON.stringify(["alpha", "beta", "gamma"]),
      "utf8",
    );

    await installPluginsFromManifest({
      workspaceDir: dir,
      env: { FOO: "bar" },
    });

    expect(cpMock.__calls).toHaveLength(3);
    expect(cpMock.__calls[0]).toMatchObject({
      bin: "claude",
      args: ["plugins", "install", "alpha"],
    });
    expect(cpMock.__calls[1].args).toEqual(["plugins", "install", "beta"]);
    expect(cpMock.__calls[2].args).toEqual(["plugins", "install", "gamma"]);
  });

  it("uses the injected claudeBin instead of the default", async () => {
    await writeFile(
      join(dir, "pangolin-plugins.json"),
      JSON.stringify(["one"]),
      "utf8",
    );

    await installPluginsFromManifest({
      workspaceDir: dir,
      env: {},
      claudeBin: "/custom/path/claude",
    });

    expect(cpMock.__calls).toHaveLength(1);
    expect(cpMock.__calls[0].bin).toBe("/custom/path/claude");
  });

  it("rejects non-array manifest shapes", async () => {
    await writeFile(
      join(dir, "pangolin-plugins.json"),
      JSON.stringify({ plugins: ["alpha"] }),
      "utf8",
    );

    await expect(
      installPluginsFromManifest({ workspaceDir: dir, env: {} }),
    ).rejects.toThrow(/JSON array/);
    expect(cpMock.__calls).toHaveLength(0);
  });

  it("throws a clear, plugin-named error when an install exits non-zero", async () => {
    await writeFile(
      join(dir, "pangolin-plugins.json"),
      JSON.stringify(["broken-plugin"]),
      "utf8",
    );
    cpMock.__config.nextExitCode = 2;

    await expect(
      installPluginsFromManifest({ workspaceDir: dir, env: {} }),
    ).rejects.toThrow(/broken-plugin/);
  });

  it("stops at the first failing plugin (sequential, fail-fast)", async () => {
    await writeFile(
      join(dir, "pangolin-plugins.json"),
      JSON.stringify(["bad", "never-reached"]),
      "utf8",
    );
    cpMock.__config.nextExitCode = 1;

    await expect(
      installPluginsFromManifest({ workspaceDir: dir, env: {} }),
    ).rejects.toThrow(/bad/);
    // Only the first plugin should have been attempted.
    expect(cpMock.__calls).toHaveLength(1);
    expect(cpMock.__calls[0].args).toEqual(["plugins", "install", "bad"]);
  });

  it("accepts an empty array manifest as a successful no-op", async () => {
    await writeFile(
      join(dir, "pangolin-plugins.json"),
      JSON.stringify([]),
      "utf8",
    );

    await expect(
      installPluginsFromManifest({ workspaceDir: dir, env: {} }),
    ).resolves.toBeUndefined();
    expect(cpMock.__calls).toHaveLength(0);
  });

  it("captures install output and throws with it on failure; never inherits stdio (F3)", async () => {
    await writeFile(
      join(dir, "pangolin-plugins.json"),
      JSON.stringify(["p"]),
      "utf8",
    );

    const workspaceDir = dir;
    const cp2 = cpMock;
    cp2.__config.nextStdout = "marker-OUTPUT-123";
    cp2.__config.nextExitCode = 3;
    const chunks: string[] = [];
    await expect(
      installPluginsFromManifest({
        workspaceDir,
        env: {},
        claudeBin: "claude",
        onOutput: (c) => chunks.push(c.text),
      }),
    ).rejects.toThrow(/plugins install .*code 3/s);
    expect(chunks.join("")).toContain("marker-OUTPUT-123");
    expect(cp2.__calls.at(-1)!.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });
});
