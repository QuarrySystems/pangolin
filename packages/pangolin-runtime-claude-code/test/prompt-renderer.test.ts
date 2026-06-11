import { describe, it, expect } from "vitest";
import { renderPrompt } from "../src/prompt-renderer.js";

describe("renderPrompt", () => {
  it("substitutes Mustache variables from input", () => {
    const out = renderPrompt({
      promptTemplate: "Hello {{name}}",
      input: { name: "world" },
      workspaceDir: "/ws",
    });
    expect(out).toBe("Hello world");
  });

  it("does NOT HTML-escape substituted values", () => {
    const out = renderPrompt({
      promptTemplate: "{{x}}",
      input: { x: "<tag>" },
      workspaceDir: "/ws",
    });
    expect(out).toBe("<tag>");
  });

  it("treats absent input as empty object when promptTemplate has no variables", () => {
    const out = renderPrompt({
      promptTemplate: "static text",
      workspaceDir: "/ws",
    });
    expect(out).toBe("static text");
  });

  it("falls back to systemPrompt when promptTemplate is absent", () => {
    expect(
      renderPrompt({ systemPrompt: "verbatim", workspaceDir: "/ws" }),
    ).toBe("verbatim");
  });

  it("prefers promptTemplate over systemPrompt when both are set", () => {
    const out = renderPrompt({
      systemPrompt: "ignored",
      promptTemplate: "templated {{v}}",
      input: { v: "wins" },
      workspaceDir: "/ws",
    });
    expect(out).toBe("templated wins");
  });

  it("throws when neither systemPrompt nor promptTemplate is set", () => {
    expect(() => renderPrompt({ workspaceDir: "/ws" })).toThrow(
      /systemPrompt or promptTemplate/,
    );
  });
});
