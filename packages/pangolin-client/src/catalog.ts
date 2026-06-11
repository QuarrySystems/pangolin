// Catalog read-side operations across the three primitives (capability,
// subagent, env). Each `get*` returns the metadata triple (name,
// registeredAt, contentHash) or `null` when the name is unknown; bodies
// (system prompts, env secret values, capability payloads) are NEVER
// returned by this surface. The MCP layer in DAG 3 wraps these read-only
// operations behind the six-tool surface.
//
// The `list*` operations are deferred per the DAG 2 plan: the
// `StorageProvider` contract exposes `list(uri)` for the version history
// of one logical name, but no `listNames(prefix)` for distinct-name
// discovery under a `<namespace>/<type>/` prefix. Rather than ship a
// half-baked implementation that scans the local filesystem (and fails
// on S3 / other providers), this module throws a clear "not yet
// implemented" error and documents the limitation. Adding distinct-name
// enumeration is a follow-up that should extend the `StorageProvider`
// contract and land in every provider in lockstep.

import {
  buildPangolinUri,
  type CapabilityRef,
  type SubagentRef,
  type EnvRef,
} from '@quarry-systems/pangolin-core';
import type { PangolinClient } from './client.js';

const NOT_IMPLEMENTED_MSG =
  'listing all names is not yet implemented — use get(name) with a known name. ' +
  'Tracking issue: StorageProvider needs a listNames(prefix) extension before catalog enumeration can land.';

async function getRef<T extends { name: string; registeredAt: string; contentHash: string }>(
  client: PangolinClient,
  type: 'capability' | 'subagent' | 'env',
  name: string,
): Promise<T | null> {
  const uri = buildPangolinUri({ namespace: client.namespace, type, name });
  const latest = await client.storage.resolveLatest(uri);
  if (!latest) return null;
  return {
    name,
    registeredAt: latest.registeredAt,
    contentHash: latest.contentHash,
  } as T;
}

/**
 * List all registered capabilities under the client's namespace.
 *
 * Deferred per the DAG 2 plan; see the file header for the rationale.
 */
export async function listCapabilities(_client: PangolinClient): Promise<CapabilityRef[]> {
  throw new Error(NOT_IMPLEMENTED_MSG);
}

/**
 * Return the latest registration metadata for a capability under the
 * client's namespace, or `null` if no capability is registered under that
 * name. NEVER returns the capability payload.
 */
export async function getCapability(
  client: PangolinClient,
  name: string,
): Promise<CapabilityRef | null> {
  return getRef<CapabilityRef>(client, 'capability', name);
}

/**
 * List all registered subagents under the client's namespace.
 *
 * Deferred per the DAG 2 plan; see the file header for the rationale.
 */
export async function listSubagents(_client: PangolinClient): Promise<SubagentRef[]> {
  throw new Error(NOT_IMPLEMENTED_MSG);
}

/**
 * Return the latest registration metadata for a subagent under the
 * client's namespace, or `null` if no subagent is registered under that
 * name. NEVER returns the system prompt or prompt template body.
 */
export async function getSubagent(
  client: PangolinClient,
  name: string,
): Promise<SubagentRef | null> {
  return getRef<SubagentRef>(client, 'subagent', name);
}

/**
 * List all registered env blobs under the client's namespace.
 *
 * Deferred per the DAG 2 plan; see the file header for the rationale.
 */
export async function listEnvs(_client: PangolinClient): Promise<EnvRef[]> {
  throw new Error(NOT_IMPLEMENTED_MSG);
}

/**
 * Return the latest registration metadata for an env blob under the
 * client's namespace, or `null` if no env is registered under that name.
 * NEVER returns secret values.
 */
export async function getEnv(
  client: PangolinClient,
  name: string,
): Promise<EnvRef | null> {
  return getRef<EnvRef>(client, 'env', name);
}
