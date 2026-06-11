import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";

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

describe("pangolin-providers-fargate scaffold shape", () => {
  it("package name is @quarry-systems/pangolin-providers-fargate", () => {
    expect(pkg.name).toBe("@quarry-systems/pangolin-providers-fargate");
  });

  it("dependencies include @quarry-systems/pangolin-core at workspace:*", () => {
    expect(pkg.dependencies?.["@quarry-systems/pangolin-core"]).toBe("workspace:*");
  });

  it("dependencies do NOT include any forbidden prefixes", () => {
    const deps = Object.keys(pkg.dependencies ?? {});
    for (const dep of deps) {
      for (const prefix of FORBIDDEN_PREFIXES) {
        expect(dep.startsWith(prefix), `Found forbidden dep: ${dep}`).toBe(false);
      }
    }
  });

  it("README mentions Fargate and ComputeProvider", () => {
    // Case-insensitive: task-readmes-per-package owns the exact prose.
    expect(readme.toLowerCase()).toContain("fargate");
    expect(readme.toLowerCase()).toContain("computeprovider");
  });
});
