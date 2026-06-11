// @quarry-systems/pangolin-mcp — runtime tool surface.
//
// Registers the six MCP tools allowed on the run-time surface per §4.6 of
// the pangolin-mvp spec. Three catalog reads (metadata only — never file
// contents, secret values, or system prompt bodies) and three dispatch
// operations:
//
//   pangolin_dispatch           → client.dispatch(...)
//   pangolin_dispatch_describe  → client.dispatch.describe(id)
//   pangolin_dispatch_cancel    → client.dispatch.cancel(id)
//   pangolin_capabilities_list  → client.capabilities.list()
//   pangolin_subagents_list     → client.subagent.list()
//   pangolin_envs_list          → client.env.list()
//
// Plus three CLIENT orchestrator tools (pure translators over OperationsApi):
//
//   pangolin_orchestrator_submit → orch.submit(plan, actor)
//   pangolin_orchestrator_status → orch.status(runId)
//   pangolin_orchestrator_watch  → orch.watch(runId, { signal }) with bounded wait
//
// Deliberately ABSENT from this surface (deploy-time privileged operations
// excluded by §7.7, and privileged/service/CLI-only orch operations):
//   - any `pangolin_*_register`
//   - any `pangolin_*_assign`
//   - pangolin_orchestrator_cancel (privileged)
//   - pangolin_orchestrator_audit  (service-only)
//   - pangolin_orchestrator_serve  (CLI-only)
// The CI check in `task-ci-mcp-tool-allowlist` enforces this architecturally;
// the names in `PANGOLIN_TOOL_NAMES` are load-bearing for that check.

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { PangolinClient } from '@quarry-systems/pangolin-client';
import type { OperationsApi, Run } from '@quarry-systems/pangolin-orchestrator';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * The exact nine tool names this server exposes, in declaration order.
 * Frozen `as const` so downstream code (and the CI allowlist check) can
 * rely on the literal tuple shape.
 */
export const PANGOLIN_TOOL_NAMES = [
  'pangolin_dispatch',
  'pangolin_dispatch_describe',
  'pangolin_dispatch_cancel',
  'pangolin_capabilities_list',
  'pangolin_subagents_list',
  'pangolin_envs_list',
  'pangolin_orchestrator_submit',
  'pangolin_orchestrator_status',
  'pangolin_orchestrator_watch',
] as const;

export type PangolinToolName = (typeof PANGOLIN_TOOL_NAMES)[number];

/**
 * Maps each orchestrator tool name to its OperationsApi method name.
 * The CI gate intersects this with PRIVILEGE to verify only client-side
 * orch tools are exposed. Only orch tools need entries here.
 */
export const PANGOLIN_TOOL_METHODS: Record<string, string> = {
  pangolin_orchestrator_submit: 'submit',
  pangolin_orchestrator_status: 'status',
  pangolin_orchestrator_watch: 'watch',
};

/**
 * Tool descriptor list returned from `tools/list`. Each entry carries a
 * description and a JSON-schema `inputSchema`. The dispatch tool's schema
 * intentionally permits `additionalProperties` so callers can pass through
 * the full `DispatchWork & ClientDispatchOpts` shape without us reflecting
 * the whole pangolin-core type tree into JSON-schema here.
 */
const TOOL_DESCRIPTORS = [
  {
    name: 'pangolin_dispatch',
    description:
      'Dispatch a unit of work to a registered subagent on a configured target. ' +
      'Returns a DispatchResult (dispatchId, exitCode, stdout/stderr, resolved refs).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Logical target name (must be configured on the PangolinClient).',
        },
        subagent: {
          description: 'Subagent short name or a pre-built SubagentRef.',
        },
        workerImage: {
          type: 'string',
          description: 'Worker container image (digest-pinned) the provider should run.',
        },
        env: {
          description: 'Env-bundle short name, EnvRef, or an array of either.',
        },
        capabilities: {
          description:
            'If set, REPLACES the subagent\'s assigned capability set. ' +
            'Cannot be combined with addCapabilities.',
        },
        addCapabilities: {
          description:
            'If set, APPENDS to the subagent\'s assigned capability set (override on name conflict).',
        },
        secrets: {
          description:
            'Per-dispatch secrets, keyed by env-var name. Each value is either a SecretRef or an InlineSecret.',
        },
        input: {
          description: 'Free-form JSON payload forwarded to the worker as PANGOLIN_INPUT_JSON.',
        },
        callback: {
          description: 'Optional callback configuration ({ url }) for streaming results back.',
        },
        timeoutSeconds: {
          type: 'number',
          description: 'Per-dispatch timeout. Falls back to defaultDispatchTimeoutSeconds.',
        },
        defaultDispatchTimeoutSeconds: {
          type: 'number',
          description: 'Fallback when work.timeoutSeconds is omitted.',
        },
        retentionDays: {
          type: 'number',
          description: 'Dispatch-record retention override (else client.retention.defaultDays).',
        },
        resources: {
          description: 'Optional resource overrides ({ cpu, memory }).',
        },
        dispatchId: {
          type: 'string',
          description: 'Caller-supplied dispatch id. If omitted, a uuid v4 is minted.',
        },
      },
      required: ['target', 'subagent', 'workerImage'],
      additionalProperties: true,
    },
  },
  {
    name: 'pangolin_dispatch_describe',
    description:
      'Look up a previously-sealed dispatch record by id. Returns the full DispatchResult. ' +
      'Throws when the record has been purged by retention (cannot be distinguished from never-existed).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dispatchId: {
          type: 'string',
          description: 'The dispatch id to describe.',
        },
      },
      required: ['dispatchId'],
      additionalProperties: false,
    },
  },
  {
    name: 'pangolin_dispatch_cancel',
    description:
      'Request cancellation of an in-flight dispatch by id. Returns void on success.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dispatchId: {
          type: 'string',
          description: 'The dispatch id to cancel.',
        },
      },
      required: ['dispatchId'],
      additionalProperties: false,
    },
  },
  {
    name: 'pangolin_capabilities_list',
    description:
      'List registered capabilities (metadata only: name, registeredAt, contentHash). ' +
      'Does NOT return capability file contents, system prompt bodies, or secret values.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'pangolin_subagents_list',
    description:
      'List registered subagents (metadata only: name, registeredAt, contentHash). ' +
      'Does NOT return subagent system-prompt bodies.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'pangolin_envs_list',
    description:
      'List registered env bundles (metadata only: name, registeredAt, contentHash). ' +
      'Does NOT return env-bundle contents or secret ARNs.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'pangolin_orchestrator_submit',
    description:
      'Submit a Run plan to the orchestrator. Returns the run id string. ' +
      'Requires the `orch` export in pangolin.config to be configured.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        plan: {
          type: 'object',
          description: 'The Run plan object (id, queue, items[]).',
        },
        actor: {
          type: 'string',
          description: 'Submitter identity string. Defaults to "agent:mcp" if omitted.',
        },
      },
      required: ['plan'],
      additionalProperties: false,
    },
  },
  {
    name: 'pangolin_orchestrator_status',
    description:
      'Return the latest status OutboxRecord for a run id. ' +
      'Requires the `orch` export in pangolin.config to be configured.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        runId: {
          type: 'string',
          description: 'The run id to query.',
        },
      },
      required: ['runId'],
      additionalProperties: false,
    },
  },
  {
    name: 'pangolin_orchestrator_watch',
    description:
      'Poll and wait for a run to reach a terminal state. Returns the last OutboxRecord seen. ' +
      'Bounded by timeoutMs (default 25000ms). ' +
      'Requires the `orch` export in pangolin.config to be configured.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        runId: {
          type: 'string',
          description: 'The run id to watch.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum milliseconds to wait. Defaults to 25000.',
        },
      },
      required: ['runId'],
      additionalProperties: false,
    },
  },
];

const ORCH_NOT_CONFIGURED =
  'orchestrator surface not configured (no `orch` export in pangolin.config)';

/**
 * Register the nine run-time Pangolin Scale tools on `server`, wiring each to the
 * matching `PangolinClient` method or `OperationsApi` method. Errors thrown by
 * client methods are caught and returned as `{ content, isError: true }`
 * responses per the MCP SDK contract — we surface `err.message` only, never
 * `err.stack`, so internal paths and trace frames do not leak to the
 * orchestrator.
 *
 * The optional third parameter `orch` wires the three orchestrator tools.
 * When absent, those tools return a clear not-configured isError response.
 */
export function registerPangolinTools(server: Server, client: PangolinClient, orch?: OperationsApi): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DESCRIPTORS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const argsObj = (args ?? {}) as Record<string, unknown>;

    try {
      switch (name) {
        case 'pangolin_dispatch': {
          // `client.dispatch` is callable; the merged DispatchWork &
          // ClientDispatchOpts shape is what the prototype-installed
          // dispatch fn expects. We cast here because JSON-schema can't
          // capture the full pangolin-core type tree.
          const result = await client.dispatch(
            argsObj as unknown as Parameters<PangolinClient['dispatch']>[0],
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        }
        case 'pangolin_dispatch_describe': {
          const dispatchId = requireString(argsObj, 'dispatchId');
          const result = await client.dispatch.describe(dispatchId);
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        }
        case 'pangolin_dispatch_cancel': {
          const dispatchId = requireString(argsObj, 'dispatchId');
          await client.dispatch.cancel(dispatchId);
          return {
            content: [{ type: 'text', text: `cancelled: ${dispatchId}` }],
          };
        }
        case 'pangolin_capabilities_list': {
          const result = await client.capabilities.list();
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        }
        case 'pangolin_subagents_list': {
          const result = await client.subagent.list();
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        }
        case 'pangolin_envs_list': {
          const result = await client.env.list();
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        }
        case 'pangolin_orchestrator_submit': {
          if (!orch) {
            return {
              content: [{ type: 'text', text: ORCH_NOT_CONFIGURED }],
              isError: true,
            };
          }
          const runId = await orch.submit(argsObj.plan as Run, (argsObj.actor as string) ?? 'agent:mcp');
          return {
            content: [{ type: 'text', text: runId }],
          };
        }
        case 'pangolin_orchestrator_status': {
          if (!orch) {
            return {
              content: [{ type: 'text', text: ORCH_NOT_CONFIGURED }],
              isError: true,
            };
          }
          const runId = requireString(argsObj, 'runId');
          const record = await orch.status(runId);
          return {
            content: [{ type: 'text', text: JSON.stringify(record) }],
          };
        }
        case 'pangolin_orchestrator_watch': {
          if (!orch) {
            return {
              content: [{ type: 'text', text: ORCH_NOT_CONFIGURED }],
              isError: true,
            };
          }
          const runId = requireString(argsObj, 'runId');
          const timeoutMs = typeof argsObj.timeoutMs === 'number' ? argsObj.timeoutMs : 25000;

          // Bound the watch with an AbortSignal so the tool always returns
          // within timeoutMs. Polling/terminal logic lives in OperationsApi.
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          let lastRecord: unknown = undefined;
          try {
            for await (const record of orch.watch(runId, { signal: controller.signal })) {
              lastRecord = record;
            }
          } catch (err: unknown) {
            // AbortError from the signal is expected at timeout — ignore it.
            const name = err instanceof Error ? err.name : '';
            if (name !== 'AbortError') {
              throw err;
            }
          } finally {
            clearTimeout(timer);
          }
          // If no record was yielded before timeout, fall back to status.
          if (lastRecord === undefined) {
            lastRecord = await orch.status(runId);
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(lastRecord) }],
          };
        }
        default:
          // Unknown tool: per MCP SDK error contract, return isError rather
          // than throwing raw. The orchestrator gets a structured response
          // it can pattern-match on.
          return {
            content: [{ type: 'text', text: `unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (err: unknown) {
      // Wrap any thrown error from the client (or arg validation) as an
      // isError response. We surface `err.message` only — never `err.stack`
      // — so internal file paths and trace frames do not leak across the
      // tool boundary to the orchestrator.
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `error invoking ${name}: ${message}` }],
        isError: true,
      };
    }
  });
}

/**
 * Pull a required string field out of a tool-call arguments object. Throws
 * a plain `Error` (caught by the dispatch handler's try/catch and reflected
 * back to the caller as an `isError` response).
 */
function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`missing required string argument: ${key}`);
  }
  return v;
}
