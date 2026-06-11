import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeAdapter } from "../src/adapter-loader.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "adapters-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeAdapter(name: string, body: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.js"), body, "utf-8");
}

describe("loadRuntimeAdapter", () => {
  it("throws when the named adapter directory does not exist", async () => {
    await expect(
      loadRuntimeAdapter("missing", { adaptersRoot: root }),
    ).rejects.toThrow(/not found/);
  });

  it("error message names the path that was checked", async () => {
    const expectedPath = join(root, "ghost");
    await expect(
      loadRuntimeAdapter("ghost", { adaptersRoot: root }),
    ).rejects.toThrow(new RegExp(expectedPath.replace(/\\/g, "\\\\")));
  });

  it("throws when the module has no default export and no createAdapter", async () => {
    await writeAdapter(
      "no-default",
      `export const unrelated = 1;\n`,
    );
    await expect(
      loadRuntimeAdapter("no-default", { adaptersRoot: root }),
    ).rejects.toThrow(/default factory/);
  });

  it("throws when the factory returns an object missing name", async () => {
    await writeAdapter(
      "no-name",
      `export default async function () {
         return { invoke: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
       };\n`,
    );
    await expect(
      loadRuntimeAdapter("no-name", { adaptersRoot: root }),
    ).rejects.toThrow(/valid RuntimeAdapter/);
  });

  it("throws when the factory returns an object missing invoke()", async () => {
    await writeAdapter(
      "no-invoke",
      `export default async function () {
         return { name: "broken" };
       };\n`,
    );
    await expect(
      loadRuntimeAdapter("no-invoke", { adaptersRoot: root }),
    ).rejects.toThrow(/valid RuntimeAdapter/);
  });

  it("loads an adapter exported as default factory", async () => {
    await writeAdapter(
      "good",
      `export default function () {
         return {
           name: "good",
           reservedPaths: [],
           invoke: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
         };
       };\n`,
    );
    const adapter = await loadRuntimeAdapter("good", { adaptersRoot: root });
    expect(adapter.name).toBe("good");
    expect(typeof adapter.invoke).toBe("function");
  });

  it("awaits an async factory", async () => {
    await writeAdapter(
      "async-good",
      `export default async function () {
         await new Promise((r) => setTimeout(r, 5));
         return {
           name: "async-good",
           reservedPaths: [],
           invoke: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
         };
       };\n`,
    );
    const adapter = await loadRuntimeAdapter("async-good", {
      adaptersRoot: root,
    });
    expect(adapter.name).toBe("async-good");
  });

  it("falls back to a named createAdapter export when default is absent", async () => {
    await writeAdapter(
      "named-export",
      `export function createAdapter() {
         return {
           name: "named-export",
           reservedPaths: [],
           invoke: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
         };
       };\n`,
    );
    const adapter = await loadRuntimeAdapter("named-export", {
      adaptersRoot: root,
    });
    expect(adapter.name).toBe("named-export");
  });
});
