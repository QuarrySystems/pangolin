import type {
  Authorizer,
  Authorization,
  AuthorizationContext,
} from '@quarry-systems/pangolin-core';

/** Default — allow-all, records nothing meaningful. Mirrors NoneSigner. Keeps demo/dev unchanged. */
export const NoneAuthorizer: Authorizer = {
  async authorize(ctx: AuthorizationContext): Promise<Authorization> {
    return {
      verdict: 'not-evaluated',
      principal: 'none',
      policyRef: 'none',
      effectClass: ctx.effectClass,
      at: ctx.at ?? '',
    };
  },
};

export interface ConfigRule {
  deny: { effectClass?: string; actor?: string; shapeId?: string };
  reason?: string;
}
export interface ConfigAuthorizerOpts {
  principal: string;
  policyRef: string;
  rules: ConfigRule[];
}

/** In-tree, dependency-free authorizer: deny if any rule's stated fields ALL match; else allow.
 *  effectClass in the decision is ALWAYS the ctx (shape-derived) value — never caller inputs. */
export function createConfigAuthorizer(opts: ConfigAuthorizerOpts): Authorizer {
  return {
    async authorize(ctx: AuthorizationContext): Promise<Authorization> {
      const at = ctx.at ?? new Date(0).toISOString();
      for (const r of opts.rules) {
        const m = r.deny;
        const hit =
          (m.effectClass === undefined || m.effectClass === ctx.effectClass) &&
          (m.actor === undefined || m.actor === ctx.actor) &&
          (m.shapeId === undefined || m.shapeId === ctx.shapeId);
        if (hit)
          return {
            verdict: 'deny',
            principal: opts.principal,
            policyRef: opts.policyRef,
            effectClass: ctx.effectClass,
            onBehalfOf: ctx.onBehalfOf,
            reason: r.reason,
            at,
          };
      }
      return {
        verdict: 'allow',
        principal: opts.principal,
        policyRef: opts.policyRef,
        effectClass: ctx.effectClass,
        onBehalfOf: ctx.onBehalfOf,
        at,
      };
    },
  };
}
