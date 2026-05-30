import { it, expect } from "vitest";
import { storeFromConfig } from "../src/store-from-config.js";
import { AwsSecretStore } from "../src/aws-secret-store.js";
import { LocalSecretStore } from "../src/local-secret-store.js";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

it("throws on unknown kind", () => {
  expect(() => storeFromConfig({ kind: "redis" as never })).toThrow(/unknown kind/);
});

it("returns AwsSecretStore for aws-secrets-manager kind", () => {
  const store = storeFromConfig({ kind: "aws-secrets-manager" });
  expect(store).toBeInstanceOf(AwsSecretStore);
  expect(store.name).toBe("aws-secrets-manager");
});

it("forwards optional client to AwsSecretStore", () => {
  const fakeClient = {} as SecretsManagerClient;
  const store = storeFromConfig({ kind: "aws-secrets-manager", client: fakeClient });
  expect(store).toBeInstanceOf(AwsSecretStore);
  expect(store.name).toBe("aws-secrets-manager");
});

it("returns LocalSecretStore for local-file kind", () => {
  const store = storeFromConfig({ kind: "local-file", dir: "/tmp/secrets" });
  expect(store).toBeInstanceOf(LocalSecretStore);
  expect(store.name).toBe("local-file");
});

it("throws when local-file kind is missing dir", () => {
  expect(() => storeFromConfig({ kind: "local-file" })).toThrow(/local-file requires dir/);
});
