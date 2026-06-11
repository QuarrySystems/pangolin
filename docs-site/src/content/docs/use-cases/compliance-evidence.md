---
title: "Use case: compliance evidence"
description: Export a sealed evidence bundle for every agent run and let an auditor re-verify it with one command — with the guarantee tier stated honestly.
---

Your customer's auditor asks what your AI agents actually did. Screenshots of
a dashboard don't survive that conversation — the evidence has to be
verifiable by someone who does not trust you, on tooling you don't control.
Pangolin Scale seals every run into an exportable bundle whose verification
**recomputes everything** rather than trusting a stored verdict.

## What you get

- **An exportable evidence bundle** per run: the per-item dispatch manifests
  (references only — secret values never appear), the hash-chained lifecycle
  log, the signed and anchored Merkle root, and a verification report.
- **One-command re-verification** — `pangolin verify bundle.json` replays the
  hash chain, recomputes the Merkle root, fetches the anchored root from the
  live anchor, checks the signature, and checks provenance closure (every
  consumed input ref must be the sealed product of a completed item in the
  same run). On a clean bundle:

```text
  pangolin verify  ·  run_a3f9c2                  ✓ TAMPER-EVIDENT
  ──────────────────────────────────────────────────────────
  ✓ chain        10 entries, hash-linked, no gaps
  ✓ root         merkle = anchored root
  ✓ signature    true
  ✓ anchor       s3:my-audit-bucket  (external-immutable)
  ✓ handoff      3 input refs accounted for
```

- **CI-gateable exit codes** — a bundle that fails any check exits non-zero,
  so verification can gate a pipeline or an incident review. `--json` emits
  the raw report; `--full` prints every ledger row.

## How the guarantee stays honest

The report's `claim` field is derived, never asserted. **`tamper-evident` is
licensed only when the anchor tier is `external-immutable` or higher and every
check passed** — any failure, including an unreachable anchor, collapses the
claim to `tamper-detecting`. The default `LocalAnchor` stores the root in the
same store as the log, so it can never earn more than tamper-detecting; the
`S3ObjectLockAnchor` writes the root to S3 Object Lock in COMPLIANCE mode — a
separate trust domain that survives a database-side rewrite. The full model,
including what each tier does **not** guarantee, is in
[Audit & guarantee tiers](/pangolin/explanation/audit-guarantee-tiers/).

## Independent verification — what the auditor needs

`pangolin verify` is deliberately **not** a pure function of the bundle file:
it fetches the anchored root from the live anchor, never the copy embedded in
the bundle (a bundle carrying its own trusted root would let a tamperer
rewrite the log and the root together). An independent auditor therefore
needs two things:

1. The bundle file.
2. Read access to the anchor that sealed the run — for the
   `external-immutable` tier, the S3 Object Lock location — wired into
   their own `pangolin.config`.

For programmatic use, the same check is the `verifyBundle(bundle, { anchor })`
entry point exported from `@quarry-systems/pangolin-orchestrator`, so an
auditor can re-verify inside their own tooling. The step-by-step flow is in
[Export & verify an audit bundle](/pangolin/how-to/verify-audit-bundle/).

## Run it yourself

Any example run ends by assembling and printing the bundle report. The
fastest offline path (no Docker, no API key) drives a real orchestrator with a
fake executor and asserts the bundle verifies:

```sh
pnpm install
pnpm --filter demo-claims-appeals-example test
```

:::caution[Shipped today vs. on the roadmap]
- `S3ObjectLockAnchor` ships, but **no concrete `S3LockClient` adapter ships
  with it** — the interface is provided and you implement the client. The
  maintainers have not run the full Fargate + S3 path end-to-end; treat
  [Deploy to Fargate + S3](/pangolin/how-to/deploy-fargate-s3/) as a
  first-run guide, not a tested recipe.
- The `witnessed` tier (a cross-organization witness such as an RFC 3161
  timestamp authority or transparency log) is **reserved in the type system
  and not implemented** — the highest claim a real deployment can earn today
  is `tamper-evident` via `external-immutable`.
- Authorization is recorded, not enforced: every operation carries an actor
  identity, but the `Authorizer` policy seam is roadmap. Today's model is
  single-operator.
- The vocabulary is **"compliance-ready," never "compliant" or "certified."**
  No tier proves the *content* of the work was correct — the trail proves what
  ran and what it produced, by reference.
:::

## Next steps

- [Audit & guarantee tiers](/pangolin/explanation/audit-guarantee-tiers/) — the full trust model.
- [Export & verify an audit bundle](/pangolin/how-to/verify-audit-bundle/) — the hands-on flow.
- [Commercial & pilots](/pangolin/commercial/) — enterprise compliance modules and pilots.
