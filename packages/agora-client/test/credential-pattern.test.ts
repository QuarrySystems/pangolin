import { describe, it, expect } from "vitest";
import { CredentialsInEnvError } from "@quarry-systems/agora-core";
import { assertNoCredentialPattern } from "../src/credential-pattern.js";

describe("assertNoCredentialPattern", () => {
  describe("benign values", () => {
    it("does not throw on an empty string", () => {
      expect(() => assertNoCredentialPattern("values.FOO", "")).not.toThrow();
    });

    it("does not throw on plain configuration text", () => {
      expect(() =>
        assertNoCredentialPattern("values.LOG_LEVEL", "info"),
      ).not.toThrow();
    });

    it("does not throw on a URL", () => {
      expect(() =>
        assertNoCredentialPattern(
          "values.API_URL",
          "https://api.example.com/v1/resources",
        ),
      ).not.toThrow();
    });
  });

  describe("AWS access key (AKIA...)", () => {
    it("throws CredentialsInEnvError when value is an AWS access key", () => {
      expect(() =>
        assertNoCredentialPattern("values.FOO", "AKIAIOSFODNN7EXAMPLE"),
      ).toThrow(CredentialsInEnvError);
    });

    it("throws when an access key is embedded in larger text", () => {
      expect(() =>
        assertNoCredentialPattern(
          "values.FOO",
          "key=AKIAIOSFODNN7EXAMPLE other stuff",
        ),
      ).toThrow(CredentialsInEnvError);
    });

    it("does not throw when allowCredentialPatterns names aws-access-key", () => {
      expect(() =>
        assertNoCredentialPattern("values.FOO", "AKIAIOSFODNN7EXAMPLE", {
          allowCredentialPatterns: ["aws-access-key"],
        }),
      ).not.toThrow();
    });
  });

  describe("AWS session key (ASIA...)", () => {
    it("throws CredentialsInEnvError on an AWS session key", () => {
      expect(() =>
        assertNoCredentialPattern("values.FOO", "ASIAIOSFODNN7EXAMPLE"),
      ).toThrow(CredentialsInEnvError);
    });

    it("does not throw when allowCredentialPatterns names aws-session-key", () => {
      expect(() =>
        assertNoCredentialPattern("values.FOO", "ASIAIOSFODNN7EXAMPLE", {
          allowCredentialPatterns: ["aws-session-key"],
        }),
      ).not.toThrow();
    });
  });

  describe("JWT shape", () => {
    it("throws CredentialsInEnvError on a JWT-shaped string", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      expect(() => assertNoCredentialPattern("values.TOKEN", jwt)).toThrow(
        CredentialsInEnvError,
      );
    });

    it("does not throw when allowCredentialPatterns names jwt", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      expect(() =>
        assertNoCredentialPattern("values.TOKEN", jwt, {
          allowCredentialPatterns: ["jwt"],
        }),
      ).not.toThrow();
    });
  });

  describe("Bearer-token prefix", () => {
    it("throws CredentialsInEnvError on a Bearer token", () => {
      expect(() =>
        assertNoCredentialPattern(
          "values.AUTH",
          "Bearer abcdef1234567890abcdef1234567890",
        ),
      ).toThrow(CredentialsInEnvError);
    });

    it("does not throw when allowCredentialPatterns names bearer-prefix", () => {
      expect(() =>
        assertNoCredentialPattern(
          "values.AUTH",
          "Bearer abcdef1234567890abcdef1234567890",
          { allowCredentialPatterns: ["bearer-prefix"] },
        ),
      ).not.toThrow();
    });
  });

  describe("GitHub tokens", () => {
    it("throws CredentialsInEnvError on a ghp_ token", () => {
      const token = "ghp_" + "A".repeat(36);
      expect(() => assertNoCredentialPattern("values.GH", token)).toThrow(
        CredentialsInEnvError,
      );
    });

    it("throws on a gho_ token", () => {
      const token = "gho_" + "B".repeat(36);
      expect(() => assertNoCredentialPattern("values.GH", token)).toThrow(
        CredentialsInEnvError,
      );
    });

    it("throws on a ghs_ token", () => {
      const token = "ghs_" + "C".repeat(36);
      expect(() => assertNoCredentialPattern("values.GH", token)).toThrow(
        CredentialsInEnvError,
      );
    });

    it("does not throw when allowCredentialPatterns names github-token", () => {
      const token = "ghp_" + "A".repeat(36);
      expect(() =>
        assertNoCredentialPattern("values.GH", token, {
          allowCredentialPatterns: ["github-token"],
        }),
      ).not.toThrow();
    });
  });

  describe("error message", () => {
    it("includes the field name", () => {
      try {
        assertNoCredentialPattern(
          "env-bundle:prod:GH_TOKEN",
          "AKIAIOSFODNN7EXAMPLE",
        );
        throw new Error("expected to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(CredentialsInEnvError);
        const ciee = err as CredentialsInEnvError;
        expect(ciee.field).toBe("env-bundle:prod:GH_TOKEN");
        expect(ciee.message).toContain("env-bundle:prod:GH_TOKEN");
      }
    });

    it("includes the named pattern that matched", () => {
      try {
        assertNoCredentialPattern("values.FOO", "AKIAIOSFODNN7EXAMPLE");
        throw new Error("expected to throw");
      } catch (err) {
        const ciee = err as CredentialsInEnvError;
        expect(ciee.detail).toContain("aws-access-key");
      }
    });

    it("includes only the first 16 chars of the matched substring (does not leak full credential)", () => {
      const fullKey = "AKIAIOSFODNN7EXAMPLE"; // 20 chars
      try {
        assertNoCredentialPattern("values.FOO", fullKey);
        throw new Error("expected to throw");
      } catch (err) {
        const ciee = err as CredentialsInEnvError;
        // first 16 chars present
        expect(ciee.detail).toContain(fullKey.slice(0, 16));
        // full key NOT present
        expect(ciee.detail).not.toContain(fullKey);
      }
    });
  });

  describe("multi-pattern interaction", () => {
    it("throws on the first match even when multiple patterns could fire", () => {
      // A string that contains both an AKIA key and a JWT — the first pattern
      // in the list (aws-access-key) should win.
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      const blob = `AKIAIOSFODNN7EXAMPLE ${jwt}`;
      try {
        assertNoCredentialPattern("values.FOO", blob);
        throw new Error("expected to throw");
      } catch (err) {
        const ciee = err as CredentialsInEnvError;
        expect(ciee.detail).toContain("aws-access-key");
      }
    });

    it("skips an allowed pattern and reports the next match", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      const blob = `AKIAIOSFODNN7EXAMPLE ${jwt}`;
      try {
        assertNoCredentialPattern("values.FOO", blob, {
          allowCredentialPatterns: ["aws-access-key"],
        });
        throw new Error("expected to throw");
      } catch (err) {
        const ciee = err as CredentialsInEnvError;
        expect(ciee.detail).toContain("jwt");
      }
    });

    it("does not throw when all matching patterns are allowlisted", () => {
      expect(() =>
        assertNoCredentialPattern("values.FOO", "AKIAIOSFODNN7EXAMPLE", {
          allowCredentialPatterns: [
            "aws-access-key",
            "aws-session-key",
            "jwt",
            "bearer-prefix",
            "github-token",
          ],
        }),
      ).not.toThrow();
    });
  });
});
