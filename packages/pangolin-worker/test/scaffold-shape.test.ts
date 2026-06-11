import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";

const pkgPath = join(__dirname, "..", "package.json");
const readmePath = join(__dirname, "..", "README.md");

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const readme = readFileSync(readmePath, "utf-8");

describe("pangolin-worker scaffold shape", () => {
  it("package name is @quarry-systems/pangolin-worker", () => {
    expect(pkg.name).toBe("@quarry-systems/pangolin-worker");
  });

  it("dependencies includes @quarry-systems/pangolin-core at workspace:*", () => {
    expect(pkg.dependencies?.["@quarry-systems/pangolin-core"]).toBe("workspace:*");
  });

  it("dependencies does NOT include any @quarry-systems/pangolin-providers-* package", () => {
    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };
    const forbidden = Object.keys(deps).filter((k) =>
      k.startsWith("@quarry-systems/pangolin-providers-")
    );
    expect(forbidden).toHaveLength(0);
  });

  it("no forbidden @quarry-systems/* prefixes other than allowed storage providers", () => {
    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };
    const quarryDeps = Object.keys(deps).filter((k) =>
      k.startsWith("@quarry-systems/")
    );
    // Storage providers at boot per spec §5.8, plus the SecretStore seam
    // the worker uses to resolve + redact per-dispatch secrets (§7.1).
    const allowed = [
      "@quarry-systems/pangolin-core",
      "@quarry-systems/pangolin-secret-store",
      "@quarry-systems/pangolin-storage-local",
      "@quarry-systems/pangolin-storage-s3",
    ];
    const unexpected = quarryDeps.filter((k) => !allowed.includes(k));
    expect(unexpected).toHaveLength(0);
  });

  it("README mentions RuntimeAdapter", () => {
    expect(readme).toContain("RuntimeAdapter");
  });

  it("README describes the worker as runtime-agnostic", () => {
    expect(readme.toLowerCase()).toContain("runtime-agnostic");
  });
});
