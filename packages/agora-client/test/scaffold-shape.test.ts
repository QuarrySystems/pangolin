import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";
import * as agoraClient from "../src/index.js";

const pkgPath = join(__dirname, "..", "package.json");
const readmePath = join(__dirname, "..", "README.md");

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const readme = readFileSync(readmePath, "utf-8");

const FORBIDDEN_PREFIXES = [
  "@stoa-mcp/",
  "@quarry-systems/bedrock-",
  "@rastate/",
  "@quarry-systems/drift-",
];

describe("agora-client scaffold shape", () => {
  it("package name is @quarry-systems/agora-client", () => {
    expect(pkg.name).toBe("@quarry-systems/agora-client");
  });

  it("dependencies include @quarry-systems/agora-core at workspace:*", () => {
    expect(pkg.dependencies?.["@quarry-systems/agora-core"]).toBe("workspace:*");
  });

  it("dependencies do NOT include any forbidden prefixes", () => {
    const deps = Object.keys(pkg.dependencies ?? {});
    for (const dep of deps) {
      for (const prefix of FORBIDDEN_PREFIXES) {
        expect(dep.startsWith(prefix), `Found forbidden dep: ${dep}`).toBe(false);
      }
    }
  });

  it("README mentions agora-client / SDK identity", () => {
    // Case-insensitive: task-readmes-per-package owns the exact prose.
    expect(readme.toLowerCase()).toContain("agora-client");
  });
});

describe("package barrel — fire/reconcile seam (D9)", () => {
  it("re-exports fireWork", () => {
    expect(typeof agoraClient.fireWork).toBe("function");
  });
});
