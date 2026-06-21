// Catalog read-side operations across the three primitives (capability,
// subagent, env). Each `get*` returns the metadata triple (name,
// registeredAt, contentHash) or `null` when the name is unknown; bodies
// (system prompts, env secret values, capability payloads) are NEVER
// returned by this surface. The MCP layer in DAG 3 wraps these read-only
// operations behind the six-tool surface.
//
// The `list*` operations enumerate distinct names under a
// `<namespace>/<type>/` prefix via the OPTIONAL `StorageProvider.listNames`
// extension (the bundled local-FS and S3 providers implement it by reusing
// the same `(namespace, type)` directory walk as `resolveByHash`). They
// return metadata triples only — never blob bodies — and scope to the
// client's namespace. A provider that does not implement `listNames` yields
// a clear "enumeration unsupported" error rather than a silent empty list.

import {
  buildPangolinUri,
  type CapabilityRef,
  type SubagentRef,
  type EnvRef,
} from '@quarry-systems/pangolin-core';
import type { PangolinClient } from './client.js';

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

async function listRefs<T extends { name: string; registeredAt: string; contentHash: string }>(
  client: PangolinClient,
  type: 'capability' | 'subagent' | 'env',
): Promise<T[]> {
  if (!client.storage.listNames) {
    throw new Error(
      `cannot list ${type}s: this storage provider (${client.storage.name}) does not support name ` +
        'enumeration (StorageProvider.listNames). Use get(name) with a known name instead.',
    );
  }
  const names = await client.storage.listNames({ namespace: client.namespace, type });
  return names.map(
    (n) => ({ name: n.name, registeredAt: n.registeredAt, contentHash: n.contentHash }) as T,
  );
}

/**
 * List the latest registration metadata for every capability under the client's
 * namespace. Metadata triples only — NEVER capability payloads.
 */
export async function listCapabilities(client: PangolinClient): Promise<CapabilityRef[]> {
  return listRefs<CapabilityRef>(client, 'capability');
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
 * List the latest registration metadata for every subagent under the client's
 * namespace. Metadata triples only — NEVER system-prompt / template bodies.
 */
export async function listSubagents(client: PangolinClient): Promise<SubagentRef[]> {
  return listRefs<SubagentRef>(client, 'subagent');
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
 * List the latest registration metadata for every env blob under the client's
 * namespace. Metadata triples only — NEVER secret values.
 */
export async function listEnvs(client: PangolinClient): Promise<EnvRef[]> {
  return listRefs<EnvRef>(client, 'env');
}

/**
 * Return the latest registration metadata for an env blob under the
 * client's namespace, or `null` if no env is registered under that name.
 * NEVER returns secret values.
 */
export async function getEnv(client: PangolinClient, name: string): Promise<EnvRef | null> {
  return getRef<EnvRef>(client, 'env', name);
}
