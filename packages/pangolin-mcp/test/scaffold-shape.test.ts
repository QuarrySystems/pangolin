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

const ALLOWLISTED_TOOL_NAMES = [
  "pangolin_dispatch",
  "pangolin_dispatch_describe",
  "pangolin_dispatch_cancel",
  "pangolin_capabilities_list",
  "pangolin_subagents_list",
  "pangolin_envs_list",
];

describe("pangolin-mcp scaffold shape", () => {
  it("package name is @quarry-systems/pangolin-mcp", () => {
    expect(pkg.name).toBe("@quarry-systems/pangolin-mcp");
  });

  it("dependencies include @quarry-systems/pangolin-client at workspace:*", () => {
    expect(pkg.dependencies?.["@quarry-systems/pangolin-client"]).toBe("workspace:*");
  });

  it("dependencies do NOT include any forbidden prefixes", () => {
    const deps = Object.keys(pkg.dependencies ?? {});
    for (const dep of deps) {
      for (const prefix of FORBIDDEN_PREFIXES) {
        expect(dep.startsWith(prefix), `Found forbidden dep: ${dep}`).toBe(false);
      }
    }
  });

  it("README contains all six allowlisted tool names verbatim", () => {
    for (const toolName of ALLOWLISTED_TOOL_NAMES) {
      expect(readme, `README missing tool name: ${toolName}`).toContain(toolName);
    }
  });
});
