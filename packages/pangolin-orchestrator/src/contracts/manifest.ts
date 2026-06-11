/** Optional cryptographic signature. Populated by the SEPARATE offload-audit
 *  wave when a Signer is configured; absent in offload-escape. */
export interface ManifestSignature {
  alg: string;
  /** base64 of the signature bytes. */
  bytes: string;
  keyRef?: string;
}

export interface DispatchManifest {
  schemaVersion: 1;
  runId: string;
  itemId: string;
  parent: string;            // "run:<runId>"
  executor: string;          // which executor kind ran this (e.g. "dispatch")
  executorManifest: unknown; // executor-defined, content-hashed, OPAQUE here
  secretRefs: string[];      // REFERENCES ONLY — never values (all executors)
  actor: string;             // "human:<id>" | "agent:<id>"
  submittedAt?: string;      // ISO-8601, when the run was submitted (if known)
  /** Typed-product handoff (spec §7): input key -> already-pinned pangolin:// URI of the
   *  upstream product this dispatch consumed. Sealed at fire; absent when the item
   *  has no needs. REFERENCES only — refs are sha256 content hashes. */
  inputRefs?: Record<string, string>;
  /** Pinned pipeline-definition URI sealed at fire; absent for default-pipeline dispatches. */
  pipelineRef?: string;
  firedAt: string;           // ISO-8601, when this item was fired
  manifestHash: string;      // sha256:<hex> self-hash over all fields above
  signature?: ManifestSignature; // offload-audit; omitted in offload-escape
}

/** The dispatch executor's `executorManifest` block shape. A future `command`
 *  executor nests a different shape under the same key — the envelope is unchanged. */
export interface DispatchExecutorManifest {
  subagent: { name: string; contentHash: string };
  capabilities: Array<{ name: string; contentHash: string }>;
  env: Array<{ name: string; contentHash: string }>;
  workerImage: string;       // digest-pinned, e.g. ghcr.io/.../pangolin-worker@sha256:...
  model: { id: string; temperature: number; maxTokens: number };
}
