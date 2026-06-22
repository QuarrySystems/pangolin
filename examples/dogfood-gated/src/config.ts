/**
 * Source-of-truth split:
 *   - plan.json  = all agent-facing instruction texts (verbatim, the driver does not template them)
 *   - config.ts  = seeds + pagePath + contracts the DRIVER needs to register things
 *
 * config.ts carries ONLY: seed file paths (subjectSeeds, gateSeeds, announceSeeds)
 * and the target page path. It does NOT duplicate or template the instruction texts
 * that live in plan.json.
 */

/** The topic/seeds manifest for a dogfood-gated run. Swap out for R6 rerun (config change only). */
export interface RunTopic {
  /** Repo-relative path to the page being created or updated. */
  pagePath: string;
  /** Seeds for the page-writer subagent: partial context (the run-2 epistemic position). */
  subjectSeeds: string[];
  /** Seeds for the fact-checker gate: full source coverage for the claims the page makes. */
  gateSeeds: string[];
  /** Seeds for the announcer subagent: CHANGELOG baseline. */
  announceSeeds: string[];
}

/**
 * Run 3 topic: execution-patterns explanation page.
 *
 * Source-of-truth split: seed paths live here; instruction texts live in plan.json.
 *
 * subjectSeeds = deliberately partial view (pattern-layer spec + dogfood README + style reference).
 * gateSeeds    = full source coverage (all five patterns, the pattern contract, orchestrator, PLUS
 *                the three subjectSeeds so the gate has the page's baseline context too).
 * announceSeeds = CHANGELOG baseline.
 */
export const EXECUTION_PATTERNS_TOPIC: RunTopic = {
  pagePath: 'docs-site/src/content/docs/explanation/execution-patterns.md',

  subjectSeeds: [
    'docs/superpowers/specs/2026-06-05-agora-pattern-layer-design.md',
    'examples/pattern-dogfood/README.md',
    'docs-site/src/content/docs/explanation/how-offload-runs.md',
  ],

  gateSeeds: [
    // Pattern source files — what the page's claims are about
    'packages/pangolin-orchestrator/src/patterns/map-reduce.ts',
    'packages/pangolin-orchestrator/src/patterns/pipeline.ts',
    'packages/pangolin-orchestrator/src/patterns/respawn.ts',
    'packages/pangolin-orchestrator/src/patterns/scan.ts',
    'packages/pangolin-orchestrator/src/patterns/static-dag.ts',
    'packages/pangolin-orchestrator/src/contracts/pattern.ts',
    'packages/pangolin-orchestrator/src/orchestrator.ts',
    // Plus the three subjectSeeds — gate needs the page's baseline context too
    'docs/superpowers/specs/2026-06-05-agora-pattern-layer-design.md',
    'examples/pattern-dogfood/README.md',
    'docs-site/src/content/docs/explanation/how-offload-runs.md',
  ],

  announceSeeds: ['CHANGELOG.md'],
};
