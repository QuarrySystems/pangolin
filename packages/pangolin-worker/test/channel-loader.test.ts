import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadChannelIfPresent } from "../src/channel-loader.js";

let workDir: string;
let adaptersRoot: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "channel-work-"));
  adaptersRoot = await mkdtemp(join(tmpdir(), "channel-adapters-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  await rm(adaptersRoot, { recursive: true, force: true });
});

async function writeAdapter(name: string, body: string): Promise<void> {
  const dir = join(adaptersRoot, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.js"), body, "utf-8");
}

async function writeManifest(payload: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(workDir, "pangolin-channel.json"),
    JSON.stringify(payload),
    "utf-8",
  );
}

describe("loadChannelIfPresent", () => {
  it("returns null when pangolin-channel.json is absent", async () => {
    const handle = await loadChannelIfPresent({ workspaceDir: workDir });
    expect(handle).toBeNull();
  });

  it("loads the named adapter and writes received messages to inbox.jsonl", async () => {
    await writeManifest({ adapter: "stub", channel: "alpha" });
    await writeAdapter(
      "stub",
      `export default function () {
         return {
           name: "stub",
           subscribe(config) {
             return {
               async *[Symbol.asyncIterator]() {
                 yield { id: "1", body: "hello", ts: "2026-01-01T00:00:00Z" };
                 yield { id: "2", body: "world", ts: "2026-01-01T00:00:01Z" };
               },
             };
           },
         };
       };\n`,
    );

    const handle = await loadChannelIfPresent({
      workspaceDir: workDir,
      adaptersRoot,
    });
    expect(handle).not.toBeNull();

    // Give the background loop a chance to drain the iterator
    await new Promise((r) => setTimeout(r, 50));
    await handle!.stop();

    const inboxPath = join(workDir, ".pangolin", "channel", "inbox.jsonl");
    const text = await readFile(inboxPath, "utf-8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ id: "1", body: "hello" });
    expect(JSON.parse(lines[1])).toMatchObject({ id: "2", body: "world" });
  });

  it("passes the configured channel and opts to the adapter", async () => {
    await writeManifest({
      adapter: "echo-config",
      channel: "beta",
      opts: { token: "secret", interval: 30 },
    });
    await writeAdapter(
      "echo-config",
      `export default function () {
         return {
           name: "echo-config",
           subscribe(config) {
             return {
               async *[Symbol.asyncIterator]() {
                 yield {
                   id: "cfg",
                   body: JSON.stringify(config),
                   ts: "2026-01-01T00:00:00Z",
                 };
               },
             };
           },
         };
       };\n`,
    );

    const handle = await loadChannelIfPresent({
      workspaceDir: workDir,
      adaptersRoot,
    });
    await new Promise((r) => setTimeout(r, 50));
    await handle!.stop();

    const text = await readFile(
      join(workDir, ".pangolin", "channel", "inbox.jsonl"),
      "utf-8",
    );
    const first = JSON.parse(text.split("\n")[0]);
    const echoed = JSON.parse(first.body);
    expect(echoed.channel).toBe("beta");
    expect(echoed.opts).toEqual({ token: "secret", interval: 30 });
  });

  it("stop() signals the iterator via return() and resolves", async () => {
    await writeManifest({ adapter: "long", channel: "gamma" });
    await writeAdapter(
      "long",
      `let returnCalled = false;
       export const _state = { returnCalled: () => returnCalled };
       export default function () {
         return {
           name: "long",
           subscribe(config) {
             return {
               [Symbol.asyncIterator]() {
                 return {
                   async next() {
                     // Block forever unless return() is called.
                     await new Promise((r) => setTimeout(r, 100000));
                     return { value: undefined, done: true };
                   },
                   async return() {
                     returnCalled = true;
                     return { value: undefined, done: true };
                   },
                 };
               },
             };
           },
         };
       };\n`,
    );

    const handle = await loadChannelIfPresent({
      workspaceDir: workDir,
      adaptersRoot,
    });
    const start = Date.now();
    await handle!.stop();
    // Should not have waited the full 10s timeout — return() short-circuits.
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("adapter failures during subscribe iteration do not throw out of stop()", async () => {
    await writeManifest({ adapter: "broken", channel: "delta" });
    await writeAdapter(
      "broken",
      `export default function () {
         return {
           name: "broken",
           subscribe(config) {
             return {
               async *[Symbol.asyncIterator]() {
                 throw new Error("kaboom");
               },
             };
           },
         };
       };\n`,
    );

    const handle = await loadChannelIfPresent({
      workspaceDir: workDir,
      adaptersRoot,
    });
    // Wait for the background loop to attempt and reject.
    await new Promise((r) => setTimeout(r, 50));
    // stop() must resolve without throwing despite the iterator failure.
    await expect(handle!.stop()).resolves.toBeUndefined();
  });

  it("creates the .pangolin/channel directory if missing", async () => {
    await writeManifest({ adapter: "stub2", channel: "epsilon" });
    await writeAdapter(
      "stub2",
      `export default function () {
         return {
           name: "stub2",
           subscribe(config) {
             return {
               async *[Symbol.asyncIterator]() {
                 yield { id: "x", body: "y", ts: "2026-01-01T00:00:00Z" };
               },
             };
           },
         };
       };\n`,
    );

    const handle = await loadChannelIfPresent({
      workspaceDir: workDir,
      adaptersRoot,
    });
    await new Promise((r) => setTimeout(r, 50));
    await handle!.stop();

    const text = await readFile(
      join(workDir, ".pangolin", "channel", "inbox.jsonl"),
      "utf-8",
    );
    expect(text).toContain('"id":"x"');
  });
});
