import { describe, it, expect } from "vitest";
import { SecretStoreMismatchError } from "../src/errors.js";

describe("SecretStoreMismatchError", () => {
  it("formats the message with the bundle, bundle kind, and target kind", () => {
    const err = new SecretStoreMismatchError("api-keys", "vault", "aws-sm");
    expect(err.message).toBe(
      'env bundle "api-keys" was staged for store kind "vault" but target uses "aws-sm"',
    );
  });

  it("renders an undefined target kind as (none)", () => {
    const err = new SecretStoreMismatchError("api-keys", "vault", undefined);
    expect(err.message).toBe(
      'env bundle "api-keys" was staged for store kind "vault" but target uses "(none)"',
    );
  });

  it("sets the name property to SecretStoreMismatchError", () => {
    const err = new SecretStoreMismatchError("b", "k", "t");
    expect(err.name).toBe("SecretStoreMismatchError");
  });

  it("is an instance of Error", () => {
    const err = new SecretStoreMismatchError("b", "k", "t");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SecretStoreMismatchError);
  });
});
