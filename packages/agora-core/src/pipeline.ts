// @quarry-systems/agora-core — pipeline contract (Wave 1, §4 of block-runner design).
//
// DATA only: what a pipeline IS. How it RUNS lives in agora-worker.
// No zod, no new dependencies. Runtime-only context (guardrail b) lives in agora-worker.

/** A block that runs the registered subagent's adapter.invoke. */
export interface AgentBlockSpec {
  kind: 'agent';
}

/** A block that runs a shell command via runBoundedCommand semantics. */
export interface ScriptBlockSpec {
  kind: 'script';
  /** Shell string passed to runBoundedCommand. Must be non-empty. */
  command: string;
  /** Positive seconds. Absent → runner defaults 600. */
  timeoutSeconds?: number;
  /**
   * `gate` (default): non-zero exit aborts the pipeline (provider-failed).
   * `verify`: report-only, never fails the pipeline — delegates to runVerify.
   */
  lens?: 'gate' | 'verify';
}

/** A block that captures workspace artifacts into the output sentinel. */
export interface CaptureBlockSpec {
  kind: 'capture';
  what: 'patch' | 'outputs';
}

/** Union of all authored block kinds. `seal` is reserved — never appears here. */
export type BlockSpec = AgentBlockSpec | ScriptBlockSpec | CaptureBlockSpec;

/**
 * A declared, content-addressed, versioned pipeline spec.
 *
 * `schemaVersion` is `1` (a literal, not a number) so TypeScript narrows the
 * discriminant at the call site. Optional-additive evolution from day 1
 * (published-contract gravity: specs are persisted and must stay readable).
 *
 * `id` must be `<pack>.<name>` (lowercase alphanumeric + hyphens, one dot).
 *
 * `blocks` must be a non-empty ordered list. `seal` is NEVER authored — the
 * runner always auto-appends it as the terminal step.
 */
export interface PipelineSpec {
  schemaVersion: 1;
  /** `'<pack>.<name>'`, e.g. `'data.transform'`. */
  id: string;
  /** Ordered block list. Must be non-empty. `seal` must not appear. */
  blocks: BlockSpec[];
  /** Edge-type tag shared with SubagentShape.outputEdgeType. Non-empty when present. */
  outputEdgeType?: string;
  /** Edge-type tags shared with SubagentShape.inputEdgeTypes. Values non-empty when present. */
  inputEdgeTypes?: Record<string, string>;
}

/**
 * Returns true iff `id` matches the pack-scoped form `<pack>.<name>`:
 * exactly one dot, both segments non-empty, lowercase alphanumeric + hyphens only.
 *
 * Hoisted here so the regex exists ONCE — orchestrator's subagent-shape.ts
 * reuses this helper rather than maintaining a private ID_RE.
 */
export function isPackScopedId(id: string): boolean {
  return /^[a-z0-9-]+\.[a-z0-9-]+$/.test(id);
}

const KNOWN_KINDS = new Set(['agent', 'script', 'capture']);

/**
 * Pure structural validator for a `PipelineSpec`.
 *
 * Returns an empty array when the spec is valid. Collects ALL errors in a
 * single pass (the validateRun style — N callers, one validator).
 *
 * Callers: `registerPipeline` (client), `agora pipeline validate` (CLI),
 * worker post-fetch re-validation.
 */
export function validatePipelineSpec(spec: PipelineSpec): string[] {
  const errors: string[] = [];

  // schemaVersion
  if (spec.schemaVersion !== 1) {
    errors.push(`unsupported schemaVersion ${String(spec.schemaVersion)}`);
  }

  // id
  if (!isPackScopedId(spec.id)) {
    errors.push(`id "${spec.id}" must be "<pack>.<name>" (lowercase alphanumeric + hyphens, one dot)`);
  }

  // blocks
  if (!Array.isArray(spec.blocks) || spec.blocks.length === 0) {
    errors.push('blocks must be a non-empty array');
  } else {
    for (const [i, b] of spec.blocks.entries()) {
      if (b === null || typeof b !== 'object') {
        errors.push(`blocks[${i}]: must be an object, got ${b === null ? 'null' : typeof b}`);
        continue;
      }

      const kind = (b as { kind?: string }).kind;

      // Reserved: seal is auto-appended by the runner
      if (kind === 'seal') {
        errors.push(
          `blocks[${i}]: 'seal' is reserved — it is auto-appended by the runner; remove it`,
        );
        continue;
      }

      // Unknown kind
      if (!kind || !KNOWN_KINDS.has(kind)) {
        errors.push(`blocks[${i}]: unknown kind "${String(kind)}"`);
        continue;
      }

      // Per-kind checks
      if (kind === 'script') {
        const s = b as ScriptBlockSpec;
        if (typeof s.command !== 'string' || s.command.length === 0) {
          errors.push(`blocks[${i}] (script): command must be a non-empty string`);
        }
        if (s.timeoutSeconds !== undefined) {
          if (typeof s.timeoutSeconds !== 'number' || s.timeoutSeconds <= 0) {
            errors.push(
              `blocks[${i}] (script): timeoutSeconds must be a positive number when present`,
            );
          }
        }
        if (s.lens !== undefined && s.lens !== 'gate' && s.lens !== 'verify') {
          errors.push(
            `blocks[${i}] (script): lens must be 'gate' or 'verify' when present, got "${String(s.lens)}"`,
          );
        }
      }

      if (kind === 'capture') {
        const c = b as CaptureBlockSpec;
        if (c.what !== 'patch' && c.what !== 'outputs') {
          errors.push(
            `blocks[${i}] (capture): what must be 'patch' or 'outputs', got "${String(c.what)}"`,
          );
        }
      }
    }
  }

  // outputEdgeType
  if (spec.outputEdgeType !== undefined && spec.outputEdgeType.length === 0) {
    errors.push('outputEdgeType must be a non-empty string when present');
  }

  // inputEdgeTypes
  if (spec.inputEdgeTypes !== undefined) {
    for (const [key, value] of Object.entries(spec.inputEdgeTypes)) {
      if (value.length === 0) {
        errors.push(`inputEdgeTypes["${key}"] must be a non-empty string`);
      }
    }
  }

  return errors;
}
