// Identity types for the agora-core surface.
//
// A `*Ref` is a stable, serializable reference to a registered artifact.
// A `*Handle` is a Ref with attached behavior (e.g. a SubagentHandle can
// be asked to bind additional capabilities). Handles are not serializable;
// Refs are.

/**
 * Reference to a registered capability bundle.
 */
export interface CapabilityRef {
  name: string;
  /** ISO 8601 timestamp of registration. */
  registeredAt: string;
  /** Content hash of the capability payload, in the form `sha256:<hex>`. */
  contentHash: string;
}

/**
 * Reference to a registered subagent template.
 */
export interface SubagentRef {
  name: string;
  /** ISO 8601 timestamp of registration. */
  registeredAt: string;
  /** Content hash of the subagent payload, in the form `sha256:<hex>`. */
  contentHash: string;
}

/**
 * Reference to a registered environment-config blob.
 */
export interface EnvRef {
  name: string;
  /** ISO 8601 timestamp of registration. */
  registeredAt: string;
  /** Content hash of the env payload, in the form `sha256:<hex>`. */
  contentHash: string;
}

/**
 * A SubagentRef plus the ability to bind capabilities. Returned by APIs
 * that produce a subagent the caller can still mutate before dispatch.
 *
 * `assign` accepts either a bare capability name (resolved against the
 * current namespace) or a fully-realized CapabilityRef.
 */
export interface SubagentHandle extends SubagentRef {
  assign(capabilities: Array<string | CapabilityRef>): Promise<SubagentRef>;
}

/**
 * Reference to a secret stored in an external secret manager
 * (e.g. AWS Secrets Manager). The runtime materializes the secret value
 * by ARN at execution time; the secret itself never crosses the API.
 */
export type SecretRef = { arn: string };

/**
 * An inline secret value bound for a single dispatch. The runtime is
 * responsible for redacting `inline` from logs and dropping it from
 * memory after `ttlSeconds` (default: dispatch duration).
 */
export interface InlineSecret {
  inline: string;
  ttlSeconds?: number;
}
