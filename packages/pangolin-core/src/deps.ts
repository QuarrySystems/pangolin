// @quarry-systems/pangolin-core — dependency evidence a dispatch reports about itself.

/**
 * Dependency evidence a dispatch reports about itself, read from
 * `.pangolin/deps.json` in the workspace.
 *
 * `tier` is deliberately a single-member union rather than a free string. The
 * sentinel is written inside the workspace, in the same environment the agent
 * runs in, so **an agent can forge it** — the worker seals whatever it reads.
 * This is RECORDED, never attested. Widening this union is a security decision,
 * not a typing convenience; reaching an attested tier would require the worker
 * to run ecosystem-specific verification itself, which the design deliberately
 * excludes. Same trust level as {@link VerifyOutcome}.
 *
 * `atSetup` / `atFinish` are sha256 of the canonicalised sentinel observed
 * after the setup script and after the agent block. **Two entries rather than
 * one is load-bearing:** an agent may add a package mid-plan, and a single
 * setup-time seal would then describe a dependency set the dispatch did not
 * actually run against — an audit record that is precisely wrong in the case
 * that matters most. When the two differ, the dispatch changed its own
 * dependency set.
 */
export interface DepsEvidence {
  atSetup: string;
  atFinish: string;
  tier: 'recorded';
}
