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

describe("pangolin-runtime-claude-code scaffold shape", () => {
  it("package name is @quarry-systems/pangolin-runtime-claude-code", () => {
    expect(pkg.name).toBe("@quarry-systems/pangolin-runtime-claude-code");
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

  it("README lists reservedPath .claude/settings.json", () => {
    expect(readme).toContain(".claude/settings.json");
  });

  it("README lists reservedPath .claude/skills/**", () => {
    expect(readme).toContain(".claude/skills/**");
  });

  it("README lists reservedPath pangolin-plugins.json", () => {
    expect(readme).toContain("pangolin-plugins.json");
  });
});
