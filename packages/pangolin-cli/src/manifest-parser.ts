// @quarry-systems/pangolin-cli — manifest-parser
// Parses + validates the `pangolin.config.yaml` manifest used by `pangolin deploy`.
// Returns a typed structure the deploy reconciler walks.

import { parse as parseYaml } from 'yaml';
import { readFile } from 'node:fs/promises';

export interface CapabilityDecl {
  name: string;
  from: string; // directory path
}

export interface SubagentDecl {
  name: string;
  systemPrompt?: string;
  promptTemplate?: string;
  model?: string;
  capabilities?: string[];
}

export interface EnvDecl {
  name: string;
  values?: Record<string, string>;
  secrets?: Record<string, { ref: string } | { inline: string; ttlSeconds?: number }>;
}

export interface PangolinManifest {
  capabilities?: CapabilityDecl[];
  subagents?: SubagentDecl[];
  envs?: EnvDecl[];
}

function asArray(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}

export async function parseManifest(path: string): Promise<PangolinManifest> {
  const raw = await readFile(path, 'utf8');
  const obj = parseYaml(raw) as unknown;
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error(`pangolin-cli: manifest at ${path} must be a YAML object`);
  }
  const m = obj as Record<string, unknown>;

  if (m.capabilities !== undefined && !Array.isArray(m.capabilities)) {
    throw new Error(`pangolin-cli: manifest.capabilities must be an array (at ${path})`);
  }
  for (const cap of asArray(m.capabilities)) {
    if (
      typeof cap !== 'object' ||
      cap === null ||
      typeof (cap as { name?: unknown }).name !== 'string' ||
      typeof (cap as { from?: unknown }).from !== 'string'
    ) {
      throw new Error(`pangolin-cli: each capability needs string 'name' and 'from' (at ${path})`);
    }
  }

  if (m.subagents !== undefined && !Array.isArray(m.subagents)) {
    throw new Error(`pangolin-cli: manifest.subagents must be an array (at ${path})`);
  }
  for (const sub of asArray(m.subagents)) {
    if (typeof sub !== 'object' || sub === null) {
      throw new Error(`pangolin-cli: subagent missing 'name' (at ${path})`);
    }
    const s = sub as Record<string, unknown>;
    if (typeof s.name !== 'string') {
      throw new Error(`pangolin-cli: subagent missing 'name' (at ${path})`);
    }
    if (typeof s.systemPrompt !== 'string' && typeof s.promptTemplate !== 'string') {
      throw new Error(
        `pangolin-cli: subagent ${s.name} needs systemPrompt or promptTemplate (at ${path})`,
      );
    }
  }

  if (m.envs !== undefined && !Array.isArray(m.envs)) {
    throw new Error(`pangolin-cli: manifest.envs must be an array (at ${path})`);
  }
  for (const env of asArray(m.envs)) {
    if (
      typeof env !== 'object' ||
      env === null ||
      typeof (env as { name?: unknown }).name !== 'string'
    ) {
      throw new Error(`pangolin-cli: env missing 'name' (at ${path})`);
    }
  }

  return m as PangolinManifest;
}
