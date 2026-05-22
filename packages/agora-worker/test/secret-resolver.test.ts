import { describe, it, expect } from "vitest";
import { SecretResolver, SecretResolutionError } from "../src/secret-resolver.js";

describe("SecretResolver", () => {
  it("resolves each ARN to its SecretString value", async () => {
    const calls: string[] = [];
    const fakeClient: any = {
      send: async (cmd: any) => {
        const id = cmd.input.SecretId as string;
        calls.push(id);
        return { SecretString: `value-of:${id}` };
      },
    };
    const resolver = new SecretResolver({ client: fakeClient });
    const out = await resolver.resolve({
      FOO: "arn:aws:secretsmanager:us-east-1:111:secret:foo",
      BAR: "arn:aws:secretsmanager:us-east-1:111:secret:bar",
    });
    expect(out).toEqual({
      FOO: "value-of:arn:aws:secretsmanager:us-east-1:111:secret:foo",
      BAR: "value-of:arn:aws:secretsmanager:us-east-1:111:secret:bar",
    });
    expect(calls).toHaveLength(2);
  });

  it("throws SecretResolutionError when the SDK throws", async () => {
    const fakeClient: any = {
      send: async () => {
        throw new Error("AccessDeniedException");
      },
    };
    const resolver = new SecretResolver({ client: fakeClient });
    await expect(resolver.resolve({ FOO: "arn:secret" })).rejects.toBeInstanceOf(
      SecretResolutionError
    );
  });

  it("populates ref and detail on SecretResolutionError when SDK throws", async () => {
    const fakeClient: any = {
      send: async () => {
        throw new Error("AccessDeniedException");
      },
    };
    const resolver = new SecretResolver({ client: fakeClient });
    try {
      await resolver.resolve({ FOO: "arn:aws:secretsmanager:us-east-1:111:secret:foo" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretResolutionError);
      const e = err as SecretResolutionError;
      expect(e.ref).toBe("arn:aws:secretsmanager:us-east-1:111:secret:foo");
      expect(e.detail).toBe("AccessDeniedException");
    }
  });

  it("throws SecretResolutionError when SecretString is undefined (binary secret)", async () => {
    const fakeClient: any = {
      send: async () => ({ SecretString: undefined, SecretBinary: new Uint8Array([1, 2, 3]) }),
    };
    const resolver = new SecretResolver({ client: fakeClient });
    try {
      await resolver.resolve({ FOO: "arn:binary" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretResolutionError);
      const e = err as SecretResolutionError;
      expect(e.ref).toBe("arn:binary");
      expect(e.detail).toMatch(/binary|SecretString/i);
    }
  });

  it("returns an empty object when no refs are supplied", async () => {
    const fakeClient: any = {
      send: async () => {
        throw new Error("should not be called");
      },
    };
    const resolver = new SecretResolver({ client: fakeClient });
    const out = await resolver.resolve({});
    expect(out).toEqual({});
  });
});
