import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";

const pkgPath = join(__dirname, "..", "package.json");
const readmePath = join(__dirname, "..", "README.md");

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const readme = readFileSync(readmePath, "utf-8");

describe("agora-worker scaffold shape", () => {
  it("package name is @quarry-systems/agora-worker", () => {
    expect(pkg.name).toBe("@quarry-systems/agora-worker");
  });

  it("dependencies includes @quarry-systems/agora-core at workspace:*", () => {
    expect(pkg.dependencies?.["@quarry-systems/agora-core"]).toBe("workspace:*");
  });

  it("dependencies does NOT include any @quarry-systems/agora-providers-* package", () => {
    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };
    const forbidden = Object.keys(deps).filter((k) =>
      k.startsWith("@quarry-systems/agora-providers-")
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
      "@quarry-systems/agora-core",
      "@quarry-systems/agora-secret-store",
      "@quarry-systems/agora-storage-local",
      "@quarry-systems/agora-storage-s3",
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
