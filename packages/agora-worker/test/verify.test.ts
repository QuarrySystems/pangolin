import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerify } from "../src/verify.js";

// runVerify runs a configured shell command in the workspace and REPORTS
// pass/fail. Unlike the setup-script runner it never throws and never gates
// the dispatch — a non-zero exit is simply `passed: false`.
//
// Tests use `node -e` (cross-platform) via shell:true so they run on the
// Windows dev host as well as the Linux container.
describe("runVerify", () => {
  let dir: string;
  const fullEnv = { ...process.env } as Record<string, string>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "verify-"));
  });
  afterEach(async () => {
    // On Windows, SIGKILL-ing a shell:true child tree (timeout test) briefly
    // locks the cwd; retry + swallow so cleanup never fails the test.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("reports passed:true on a zero-exit command and captures its output", async () => {
    const res = await runVerify({
      workspaceDir: dir,
      command: `node -e "console.log('verify-ok'); process.exit(0)"`,
      env: fullEnv,
      timeoutSeconds: 30,
    });
    expect(res.passed).toBe(true);
    expect(res.report).toContain("verify-ok");
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports passed:false on a non-zero exit and captures stderr", async () => {
    const res = await runVerify({
      workspaceDir: dir,
      command: `node -e "console.error('verify-boom'); process.exit(1)"`,
      env: fullEnv,
      timeoutSeconds: 30,
    });
    expect(res.passed).toBe(false);
    expect(res.report).toContain("verify-boom");
  });

  it("reports passed:false and returns bounded when the command exceeds the timeout", async () => {
    const start = Date.now();
    const res = await runVerify({
      workspaceDir: dir,
      command: `node -e "setTimeout(function(){}, 10000)"`,
      env: fullEnv,
      timeoutSeconds: 1,
    });
    expect(res.passed).toBe(false);
    expect(Date.now() - start).toBeLessThan(5000);
  }, 10_000);

  it("truncates an oversized report to the configured limit", async () => {
    const res = await runVerify({
      workspaceDir: dir,
      command: `node -e "process.stdout.write('x'.repeat(50000))"`,
      env: fullEnv,
      timeoutSeconds: 30,
      reportLimit: 200,
    });
    expect(res.passed).toBe(true);
    expect(res.report!.length).toBeLessThan(400);
  });
});
