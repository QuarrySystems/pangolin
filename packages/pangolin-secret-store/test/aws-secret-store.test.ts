import { describe, it, expect } from "vitest";
import { AwsSecretStore } from "../src/aws-secret-store.js";

interface FakeCommand {
  constructor: { name: string };
  input: Record<string, unknown>;
}

describe("AwsSecretStore", () => {
  describe("stage", () => {
    it("creates a secret and returns its ARN as the ref plus the ttl", async () => {
      const sent: FakeCommand[] = [];
      const fakeClient = {
        send: async (cmd: FakeCommand) => {
          sent.push(cmd);
          return { ARN: "arn:aws:secretsmanager:us-east-1:1:secret:foo-AbC" };
        },
      };
      const store = new AwsSecretStore({ client: fakeClient as never });
      const staged = await store.stage({
        name: "pangolin/inline/d-1/FOO",
        value: "s3cr3t",
        ttlSeconds: 7500,
        tags: { "pangolin:dispatchId": "d-1" },
      });
      expect(staged.ref).toBe("arn:aws:secretsmanager:us-east-1:1:secret:foo-AbC");
      expect(staged.ttlSeconds).toBe(7500);

      const create = sent.find((c) => c.constructor.name === "CreateSecretCommand");
      expect(create).toBeDefined();
      expect(create!.input.Name).toBe("pangolin/inline/d-1/FOO");
      expect(create!.input.SecretString).toBe("s3cr3t");
      // The provided tag plus the ttl tag are both present.
      const tags = create!.input.Tags as Array<{ Key: string; Value: string }>;
      expect(tags).toContainEqual({ Key: "pangolin:dispatchId", Value: "d-1" });
      expect(tags).toContainEqual({ Key: "pangolin:ttlSeconds", Value: "7500" });
    });

    it("throws when CreateSecret returns no ARN", async () => {
      const store = new AwsSecretStore({
        client: { send: async () => ({}) } as never,
      });
      await expect(
        store.stage({ name: "n", value: "v", ttlSeconds: 1 }),
      ).rejects.toThrow();
    });
  });

  describe("resolve", () => {
    it("resolves a ref to its SecretString", async () => {
      const store = new AwsSecretStore({
        client: {
          send: async (cmd: FakeCommand) => ({
            SecretString: `value-of:${cmd.input.SecretId as string}`,
          }),
        } as never,
      });
      const value = await store.resolve("arn:aws:secretsmanager:us-east-1:1:secret:bar");
      expect(value).toBe("value-of:arn:aws:secretsmanager:us-east-1:1:secret:bar");
    });

    it("throws when SecretString is empty (binary secret)", async () => {
      const store = new AwsSecretStore({
        client: { send: async () => ({ SecretString: undefined }) } as never,
      });
      await expect(store.resolve("arn:secret")).rejects.toThrow();
    });
  });

  describe("cleanupByTag", () => {
    it("lists secrets by tag filter and force-deletes each, across pages", async () => {
      const deleted: string[] = [];
      let listCalls = 0;
      const store = new AwsSecretStore({
        client: {
          send: async (cmd: FakeCommand) => {
            if (cmd.constructor.name === "ListSecretsCommand") {
              listCalls++;
              if (listCalls === 1) {
                return {
                  SecretList: [{ ARN: "arn:a" }, { ARN: "arn:b" }],
                  NextToken: "page2",
                };
              }
              return { SecretList: [{ ARN: "arn:c" }], NextToken: undefined };
            }
            if (cmd.constructor.name === "DeleteSecretCommand") {
              deleted.push(cmd.input.SecretId as string);
              expect(cmd.input.ForceDeleteWithoutRecovery).toBe(true);
              return {};
            }
            return {};
          },
        } as never,
      });
      await store.cleanupByTag("pangolin:dispatchId", "d-1");
      expect(deleted).toEqual(["arn:a", "arn:b", "arn:c"]);
    });
  });

  it("exposes a stable provider name", () => {
    const store = new AwsSecretStore({ client: { send: async () => ({}) } as never });
    expect(store.name).toBe("aws-secrets-manager");
  });
});
