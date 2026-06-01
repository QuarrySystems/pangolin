export type PrivilegeTag = 'client' | 'privileged' | 'service';
export interface MethodPolicy { tag: PrivilegeTag; mcp: boolean; }

/** Single source of method→policy. `mcp:true` ⇔ tag==='client' && method!=='audit'
 *  (audit is client + read-only but a CLI-only operator action — never on MCP). */
export const PRIVILEGE: Record<string, MethodPolicy> = {
  submit: { tag: 'client',     mcp: true  },
  status: { tag: 'client',     mcp: true  },
  watch:  { tag: 'client',     mcp: true  },
  cancel: { tag: 'privileged', mcp: false },
  audit:  { tag: 'client',     mcp: false },
  serve:  { tag: 'service',    mcp: false },
  tick:   { tag: 'service',    mcp: false },
};

/** True iff a method is eligible to be exposed as an MCP tool. */
export function isMcpEligible(method: string): boolean {
  return PRIVILEGE[method]?.mcp === true;
}
