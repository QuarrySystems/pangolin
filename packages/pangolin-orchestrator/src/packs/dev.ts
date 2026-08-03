import { z } from 'zod';
import { patchSchema, intentSchema } from '../contracts/core-types.js';
import type { SubagentShape } from '../contracts/subagent-shape.js';
import { PackRegistry } from './registry.js';

// NOT a dispatch gate, despite how the old TODO here read. `imageDigest` is
// consulted by exactly one thing — `validateShape`'s truthiness check — and this
// placeholder is truthy. Nothing at dispatch time reads it: `DispatchExecutor.fire`
// never references `subagentShape` or `capability`, and takes `workerImage` from
// executor config. So dev shapes ARE dispatchable today, and replacing this
// constant alone would change no behaviour. See KNOWN-ISSUES 17a; the pin only
// becomes meaningful once something enforces it.
const WORKER_IMAGE = 'sha256:PLACEHOLDER';

export const devCodeEdit: SubagentShape = {
  id: 'dev.code-edit',
  effectTier: 'write-impure',
  inputSchema: z.object({ baseCommit: z.string(), instructions: z.string() }),
  outputSchema: z.object({ patch: patchSchema, intents: z.array(intentSchema).optional() }),
  capability: {
    imageDigest: WORKER_IMAGE,
    permissions: {},
    contextShape: 'repo worktree at baseCommit',
  },
  outputEdgeType: 'patch-ref',
};

export const devVerify: SubagentShape = {
  id: 'dev.verify',
  effectTier: 'read-impure',
  inputSchema: z.object({ patch: patchSchema }),
  outputSchema: z.object({ passed: z.boolean(), report: z.string() }),
  capability: {
    imageDigest: WORKER_IMAGE,
    permissions: {},
    contextShape: 'repo snapshot + patch applied',
  },
  inputEdgeTypes: { patch: 'patch-ref' },
};

export const devPack: SubagentShape[] = [devCodeEdit, devVerify];
export const devRegistry = (): PackRegistry => new PackRegistry(devPack);
