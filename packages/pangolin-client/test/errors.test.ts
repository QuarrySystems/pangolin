import { describe, it, expect } from "vitest";
import { SecretStoreMismatchError, DispatchAlreadyExistsError } from "../src/errors.js";

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

describe("DispatchAlreadyExistsError", () => {
  it("sets the name property to DispatchAlreadyExistsError", () => {
    const err = new DispatchAlreadyExistsError("D1");
    expect(err.name).toBe("DispatchAlreadyExistsError");
  });

  it("carries the dispatchId", () => {
    const err = new DispatchAlreadyExistsError("D1");
    expect(err.dispatchId).toBe("D1");
  });

  it("is an instance of Error", () => {
    const err = new DispatchAlreadyExistsError("D1");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DispatchAlreadyExistsError);
  });
});
