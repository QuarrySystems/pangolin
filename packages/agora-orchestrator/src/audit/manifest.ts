import { canonicalJsonString, computeContentHash } from '@quarry-systems/agora-core';
import type { DispatchManifest } from '../contracts/manifest.js';

export interface BuildManifestInput {
  runId: string;
  itemId: string;
  executor: string;
  executorManifest: unknown;
  secretRefs: string[];
  actor: string;
  firedAt: string;
  submittedAt?: string;
  inputRefs?: Record<string, string>;
  pipelineRef?: string;
}

/** Build a manifest and compute its self-hash. The hash is taken over the
 *  canonical form of every field EXCEPT `manifestHash` and `signature`, so the
 *  hash is stable regardless of later signing. Returns the manifest plus the
 *  canonical bytes to persist (content-addressing happens at the storage layer). */
export function buildManifest(input: BuildManifestInput): {
  manifest: DispatchManifest;
  bytes: Uint8Array;
} {
  if (input.secretRefs.some((r) => typeof r !== 'string')) {
    throw new Error('buildManifest: secretRefs must be string references only');
  }
  const base = {
    schemaVersion: 1 as const,
    runId: input.runId,
    itemId: input.itemId,
    parent: `run:${input.runId}`,
    executor: input.executor,
    executorManifest: input.executorManifest,
    secretRefs: input.secretRefs,
    actor: input.actor,
    submittedAt: input.submittedAt,
    firedAt: input.firedAt,
    inputRefs: input.inputRefs,
    pipelineRef: input.pipelineRef,
  };
  // computeContentHash canonicalizes objects internally (sorted keys, drops
  // undefined — so an absent submittedAt does not perturb the hash).
  const manifestHash = computeContentHash(base);
  const manifest: DispatchManifest = { ...base, manifestHash };
  const bytes = new TextEncoder().encode(canonicalJsonString(manifest));
  return { manifest, bytes };
}
