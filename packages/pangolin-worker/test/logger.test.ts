import { describe, it, expect, beforeEach, vi } from "vitest";
import { StructuredLogger } from "../src/logger.js";

describe("StructuredLogger", () => {
  let logger: StructuredLogger;

  beforeEach(() => {
    logger = new StructuredLogger();
  });

  it("exports StructuredLogger class", () => {
    expect(logger).toBeDefined();
  });

  it("writes a single JSON line to stdout", () => {
    const writeStub = vi.spyOn(process.stdout, "write");

    logger.log({ kind: "test" });

    expect(writeStub).toHaveBeenCalledOnce();
    const call = writeStub.mock.calls[0][0] as string;
    expect(call).toContain('"kind":"test"');
    expect(call.endsWith("\n")).toBe(true);

    writeStub.mockRestore();
  });

  it("registerSecret adds a literal string to redaction set", () => {
    const writeStub = vi.spyOn(process.stdout, "write");

    logger.registerSecret("supersecret");
    logger.log({ kind: "test", password: "supersecret" });

    const call = writeStub.mock.calls[0][0] as string;
    expect(call).toContain("<redacted:secret>");
    expect(call).not.toContain("supersecret");

    writeStub.mockRestore();
  });

  it("does not register empty-string secrets", () => {
    const writeStub = vi.spyOn(process.stdout, "write");

    logger.registerSecret("");
    logger.log({ kind: "test", value: "" });

    const call = writeStub.mock.calls[0][0] as string;
    expect(call).toContain('""'); // empty string should appear as empty string

    writeStub.mockRestore();
  });

  it("redacts secrets in nested objects", () => {
    const writeStub = vi.spyOn(process.stdout, "write");

    logger.registerSecret("my-api-key");
    logger.log({
      kind: "auth",
      user: {
        name: "alice",
        key: "my-api-key",
      },
    });

    const call = writeStub.mock.calls[0][0] as string;
    expect(call).toContain("<redacted:secret>");
    expect(call).not.toContain("my-api-key");

    writeStub.mockRestore();
  });

  it("redacts secrets in arrays", () => {
    const writeStub = vi.spyOn(process.stdout, "write");

    logger.registerSecret("token123");
    logger.log({
      kind: "tokens",
      values: ["token123", "safe"],
    });

    const call = writeStub.mock.calls[0][0] as string;
    expect(call).toContain("<redacted:secret>");
    expect(call).not.toContain("token123");
    expect(call).toContain("safe");

    writeStub.mockRestore();
  });

  it("redacts secrets recursively in deeply nested structures", () => {
    const writeStub = vi.spyOn(process.stdout, "write");

    logger.registerSecret("secret123");
    logger.log({
      kind: "nested",
      level1: {
        level2: {
          level3: {
            data: ["secret123", { value: "secret123" }],
          },
        },
      },
    });

    const call = writeStub.mock.calls[0][0] as string;
    expect(call).not.toContain("secret123");
    expect(call).toContain("<redacted:secret>");

    writeStub.mockRestore();
  });

  it("handles multiple registered secrets", () => {
    const writeStub = vi.spyOn(process.stdout, "write");

    logger.registerSecret("password123");
    logger.registerSecret("api-key-456");
    logger.log({
      kind: "creds",
      password: "password123",
      api: "api-key-456",
    });

    const call = writeStub.mock.calls[0][0] as string;
    expect(call).not.toContain("password123");
    expect(call).not.toContain("api-key-456");
    expect(call.match(/<redacted:secret>/g)?.length).toBe(2);

    writeStub.mockRestore();
  });

  it("redacts secrets within larger strings", () => {
    const writeStub = vi.spyOn(process.stdout, "write");

    logger.registerSecret("SECRET");
    logger.log({
      kind: "message",
      text: "my SECRET is important",
    });

    const call = writeStub.mock.calls[0][0] as string;
    expect(call).toContain("my <redacted:secret> is important");
    expect(call).not.toContain("my SECRET");

    writeStub.mockRestore();
  });

  it("redactString redacts registered secrets from a free string", () => {
    logger.registerSecret("sk-abc123");
    const out = logger.redactString("ANTHROPIC_API_KEY=sk-abc123 done");
    expect(out).toBe("ANTHROPIC_API_KEY=<redacted:secret> done");
    expect(out).not.toContain("sk-abc123");
  });

  it("preserves non-string, non-array, non-object values", () => {
    const writeStub = vi.spyOn(process.stdout, "write");

    logger.log({
      kind: "mixed",
      num: 42,
      bool: true,
      nil: null,
      undef: undefined,
    });

    const call = writeStub.mock.calls[0][0] as string;
    expect(call).toContain("42");
    expect(call).toContain("true");
    expect(call).toContain("null");

    writeStub.mockRestore();
  });
});
