import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeAdapter } from "@quarry-systems/pangolin-core";
import { MergeTypeConflictError } from "../src/merge-rules.js";
import {
  overlayCapabilities,
  type CapabilityBundle,
} from "../src/overlay-engine.js";

let workspaceDir: string;

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "overlay-"));
});

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

function makeAdapter(opts: Partial<RuntimeAdapter> = {}): RuntimeAdapter {
  return {
    name: opts.name ?? "fake-adapter",
    reservedPaths: opts.reservedPaths ?? [],
    mergeRules: opts.mergeRules,
    invoke: opts.invoke ?? (async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  };
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function json(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

async function readUtf8(path: string): Promise<string> {
  return await readFile(path, "utf-8");
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readUtf8(path));
}

describe("overlayCapabilities — materialization", () => {
  it("materializes a single bundle's files into workspaceDir", async () => {
    const bundle: CapabilityBundle = {
      name: "cap-a",
      files: {
        "README.md": utf8("hello world"),
      },
    };

    await overlayCapabilities({
      workspaceDir,
      bundles: [bundle],
      adapter: makeAdapter(),
    });

    expect(await readUtf8(join(workspaceDir, "README.md"))).toBe("hello world");
  });

  it("creates parent directories for nested paths", async () => {
    const bundle: CapabilityBundle = {
      name: "cap",
      files: {
        ".claude/skills/foo/SKILL.md": utf8("# skill"),
      },
    };

    await overlayCapabilities({
      workspaceDir,
      bundles: [bundle],
      adapter: makeAdapter(),
    });

    const written = await readUtf8(
      join(workspaceDir, ".claude/skills/foo/SKILL.md"),
    );
    expect(written).toBe("# skill");
  });

  it("writes opaque bytes byte-for-byte", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 254, 255]);
    const bundle: CapabilityBundle = {
      name: "cap",
      files: { "blob.bin": bytes },
    };

    await overlayCapabilities({
      workspaceDir,
      bundles: [bundle],
      adapter: makeAdapter(),
    });

    const onDisk = await readFile(join(workspaceDir, "blob.bin"));
    expect(new Uint8Array(onDisk)).toEqual(bytes);
  });

  it("does nothing harmful when given zero bundles", async () => {
    await overlayCapabilities({
      workspaceDir,
      bundles: [],
      adapter: makeAdapter(),
    });

    // workspaceDir still exists and is empty
    const s = await stat(workspaceDir);
    expect(s.isDirectory()).toBe(true);
  });
});

describe("overlayCapabilities — default last-write-wins", () => {
  it("uses last-write-wins for arbitrary paths (later bundle overwrites)", async () => {
    const first: CapabilityBundle = {
      name: "first",
      files: { "src/foo.ts": utf8("// first") },
    };
    const second: CapabilityBundle = {
      name: "second",
      files: { "src/foo.ts": utf8("// second") },
    };

    await overlayCapabilities({
      workspaceDir,
      bundles: [first, second],
      adapter: makeAdapter(),
    });

    expect(await readUtf8(join(workspaceDir, "src/foo.ts"))).toBe("// second");
  });

  it("walks bundles in declared order (first then second)", async () => {
    const a: CapabilityBundle = { name: "a", files: { "x.txt": utf8("A") } };
    const b: CapabilityBundle = { name: "b", files: { "x.txt": utf8("B") } };
    const c: CapabilityBundle = { name: "c", files: { "x.txt": utf8("C") } };

    await overlayCapabilities({
      workspaceDir,
      bundles: [a, b, c],
      adapter: makeAdapter(),
    });

    expect(await readUtf8(join(workspaceDir, "x.txt"))).toBe("C");
  });
});

describe("overlayCapabilities — pangolin-defined manifest rules", () => {
  it("uses array-union for pangolin-notifications.json at the root", async () => {
    const a: CapabilityBundle = {
      name: "a",
      files: { "pangolin-notifications.json": json(["slack", "email"]) },
    };
    const b: CapabilityBundle = {
      name: "b",
      files: { "pangolin-notifications.json": json(["email", "webhook"]) },
    };

    await overlayCapabilities({
      workspaceDir,
      bundles: [a, b],
      adapter: makeAdapter(),
    });

    const merged = await readJson(
      join(workspaceDir, "pangolin-notifications.json"),
    );
    expect(merged).toEqual(["slack", "email", "webhook"]);
  });

  it("uses last-write-wins for pangolin-channel.json", async () => {
    const a: CapabilityBundle = {
      name: "a",
      files: { "pangolin-channel.json": json({ name: "old" }) },
    };
    const b: CapabilityBundle = {
      name: "b",
      files: { "pangolin-channel.json": json({ name: "new" }) },
    };

    await overlayCapabilities({
      workspaceDir,
      bundles: [a, b],
      adapter: makeAdapter(),
    });

    expect(await readJson(join(workspaceDir, "pangolin-channel.json"))).toEqual({
      name: "new",
    });
  });

  it("uses last-write-wins for pangolin-setup.sh", async () => {
    const a: CapabilityBundle = {
      name: "a",
      files: { "pangolin-setup.sh": utf8("#!/bin/sh\necho first\n") },
    };
    const b: CapabilityBundle = {
      name: "b",
      files: { "pangolin-setup.sh": utf8("#!/bin/sh\necho second\n") },
    };

    await overlayCapabilities({
      workspaceDir,
      bundles: [a, b],
      adapter: makeAdapter(),
    });

    expect(await readUtf8(join(workspaceDir, "pangolin-setup.sh"))).toBe(
      "#!/bin/sh\necho second\n",
    );
  });

  it("matches pangolin-notifications.json under a nested directory", async () => {
    const a: CapabilityBundle = {
      name: "a",
      files: { "subdir/pangolin-notifications.json": json(["x"]) },
    };
    const b: CapabilityBundle = {
      name: "b",
      files: { "subdir/pangolin-notifications.json": json(["x", "y"]) },
    };

    await overlayCapabilities({
      workspaceDir,
      bundles: [a, b],
      adapter: makeAdapter(),
    });

    const merged = await readJson(
      join(workspaceDir, "subdir/pangolin-notifications.json"),
    );
    expect(merged).toEqual(["x", "y"]);
  });
});

describe("overlayCapabilities — adapter-reserved paths", () => {
  it("applies adapter mergeRules to a literal reserved path", async () => {
    const adapter = makeAdapter({
      reservedPaths: [".claude/settings.json"],
      mergeRules: {
        ".claude/settings.json": { strategy: "deep-merge" },
      },
    });
    const a: CapabilityBundle = {
      name: "a",
      files: { ".claude/settings.json": json({ a: 1, shared: "first" }) },
    };
    const b: CapabilityBundle = {
      name: "b",
      files: { ".claude/settings.json": json({ b: 2, shared: "second" }) },
    };

    await overlayCapabilities({
      workspaceDir,
      bundles: [a, b],
      adapter,
    });

    expect(await readJson(join(workspaceDir, ".claude/settings.json"))).toEqual(
      { a: 1, b: 2, shared: "second" },
    );
  });

  it("applies adapter mergeRules to paths matched by a ** glob", async () => {
    const adapter = makeAdapter({
      reservedPaths: [".claude/skills/**"],
      mergeRules: {
        ".claude/skills/**": { strategy: "last-write-wins" },
      },
    });
    const a: CapabilityBundle = {
      name: "a",
      files: { ".claude/skills/foo/SKILL.md": utf8("first") },
    };
    const b: CapabilityBundle = {
      name: "b",
      files: { ".claude/skills/foo/SKILL.md": utf8("second") },
    };

    await overlayCapabilities({
      workspaceDir,
      bundles: [a, b],
      adapter,
    });

    expect(
      await readUtf8(join(workspaceDir, ".claude/skills/foo/SKILL.md")),
    ).toBe("second");
  });

  it("applies adapter array-union mergeRule to a reserved path", async () => {
    const adapter = makeAdapter({
      reservedPaths: [".claude/tags.json"],
      mergeRules: {
        ".claude/tags.json": { strategy: "array-union" },
      },
    });
    const a: CapabilityBundle = {
      name: "a",
      files: { ".claude/tags.json": json(["alpha", "beta"]) },
    };
    const b: CapabilityBundle = {
      name: "b",
      files: { ".claude/tags.json": json(["beta", "gamma"]) },
    };

    await overlayCapabilities({
      workspaceDir,
      bundles: [a, b],
      adapter,
    });

    expect(await readJson(join(workspaceDir, ".claude/tags.json"))).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("falls back to last-write-wins when reservedPaths matches but no mergeRule exists", async () => {
    const adapter = makeAdapter({
      reservedPaths: [".claude/orphan.json"],
      // mergeRules: undefined
    });
    const a: CapabilityBundle = {
      name: "a",
      files: { ".claude/orphan.json": json({ a: 1 }) },
    };
    const b: CapabilityBundle = {
      name: "b",
      files: { ".claude/orphan.json": json({ b: 2 }) },
    };

    await overlayCapabilities({
      workspaceDir,
      bundles: [a, b],
      adapter,
    });

    expect(await readJson(join(workspaceDir, ".claude/orphan.json"))).toEqual({
      b: 2,
    });
  });
});

describe("overlayCapabilities — rule precedence", () => {
  it("pangolin-manifest rules take precedence over adapter reserved paths", async () => {
    // Adapter wants to claim pangolin-notifications.json as last-write-wins,
    // but the Pangolin Scale rule (array-union) must win.
    const adapter = makeAdapter({
      reservedPaths: ["pangolin-notifications.json"],
      mergeRules: {
        "pangolin-notifications.json": { strategy: "last-write-wins" },
      },
    });
    const a: CapabilityBundle = {
      name: "a",
      files: { "pangolin-notifications.json": json(["x"]) },
    };
    const b: CapabilityBundle = {
      name: "b",
      files: { "pangolin-notifications.json": json(["y"]) },
    };

    await overlayCapabilities({
      workspaceDir,
      bundles: [a, b],
      adapter,
    });

    expect(
      await readJson(join(workspaceDir, "pangolin-notifications.json")),
    ).toEqual(["x", "y"]);
  });
});

describe("overlayCapabilities — type conflicts propagate", () => {
  it("propagates MergeTypeConflictError from deep-merge", async () => {
    const adapter = makeAdapter({
      reservedPaths: [".claude/settings.json"],
      mergeRules: {
        ".claude/settings.json": { strategy: "deep-merge" },
      },
    });
    const a: CapabilityBundle = {
      name: "a",
      files: { ".claude/settings.json": json({ a: { nested: 1 } }) },
    };
    const b: CapabilityBundle = {
      name: "b",
      files: { ".claude/settings.json": json({ a: "scalar" }) },
    };

    await expect(
      overlayCapabilities({
        workspaceDir,
        bundles: [a, b],
        adapter,
      }),
    ).rejects.toBeInstanceOf(MergeTypeConflictError);
  });

  it("propagates MergeTypeConflictError from array-union when input is not an array", async () => {
    // pangolin-notifications.json is forced array-union — feed it a non-array
    // in the second bundle.
    const a: CapabilityBundle = {
      name: "a",
      files: { "pangolin-notifications.json": json(["x"]) },
    };
    const b: CapabilityBundle = {
      name: "b",
      files: { "pangolin-notifications.json": json({ not: "array" }) },
    };

    await expect(
      overlayCapabilities({
        workspaceDir,
        bundles: [a, b],
        adapter: makeAdapter(),
      }),
    ).rejects.toBeInstanceOf(MergeTypeConflictError);
  });
});

describe("overlayCapabilities — merged JSON serialization", () => {
  it("writes merged JSON as valid UTF-8 JSON that parses back", async () => {
    const adapter = makeAdapter({
      reservedPaths: [".claude/settings.json"],
      mergeRules: {
        ".claude/settings.json": { strategy: "deep-merge" },
      },
    });
    const a: CapabilityBundle = {
      name: "a",
      files: { ".claude/settings.json": json({ x: 1 }) },
    };
    const b: CapabilityBundle = {
      name: "b",
      files: { ".claude/settings.json": json({ y: 2 }) },
    };

    await overlayCapabilities({
      workspaceDir,
      bundles: [a, b],
      adapter,
    });

    const text = await readUtf8(join(workspaceDir, ".claude/settings.json"));
    expect(JSON.parse(text)).toEqual({ x: 1, y: 2 });
  });

  it("does not JSON-parse opaque (non-JSON) text files; writes them as-is", async () => {
    // No merge rule applies — last-write-wins on the raw bytes path.
    const bundle: CapabilityBundle = {
      name: "a",
      files: { "notes.txt": utf8("just text, not { json }") },
    };

    await overlayCapabilities({
      workspaceDir,
      bundles: [bundle],
      adapter: makeAdapter(),
    });

    expect(await readUtf8(join(workspaceDir, "notes.txt"))).toBe(
      "just text, not { json }",
    );
  });
});
