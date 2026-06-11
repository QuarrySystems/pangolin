---
title: "ADR-0007: Inline secret TTL is auto-computed from dispatch timeout"
description: "Inline secret TTL is auto-computed from dispatch timeout plus a 5-minute cleanup grace."
status: accepted
date: 2026-05-21
deciders: pangolin-scale-mvp-design
---

## Context

When an integrator passes an inline secret to `env.register()`, the SDK
stages it in AWS Secrets Manager and stores only the resulting ARN as part
of the env bundle's content (§7.1). The staged secret needs a TTL so that,
if the worker fails catastrophically before pangolin-client can clean up, the
secret is auto-deleted rather than left dangling indefinitely.

Prior guidance asked integrators to size `ttlSeconds` themselves
("size to 2x expected duration"). In practice this is a footgun:

- Integrators who under-size cause secrets to expire mid-dispatch, which
  surfaces as a confusing worker-side `GetSecretValue` failure rather than
  a clear TTL error.
- Integrators who over-size leave secrets in Secrets Manager well after
  the dispatch is done, increasing the exposure window with no benefit.
- The "right" value is mechanically derivable from information the SDK
  already has (the dispatch timeout). Making humans compute it manually
  is wasted work and a source of inconsistency.

The narrow case where an integrator legitimately wants to override is
compliance-driven shorter lifetimes — e.g., "rotation policy requires
every staged credential expire within N minutes regardless of dispatch
duration." That use case is still supported.

## Decision

From §10.1:

> **Inline secret TTL is auto-computed from dispatch timeout + 5-minute
> cleanup grace.** Default `dispatch.timeoutSeconds` (when unspecified) is
> 7200 seconds (2 hours). Integrators don't size TTLs themselves; the
> `ttlSeconds` field is an override for compliance-driven shorter
> lifetimes only. This supersedes the prior "size to 2x expected
> duration" guidance.

The formula is:

```
ttlSeconds = (dispatch.timeoutSeconds ?? 7200) + 300
```

That is: take the dispatch's configured timeout (defaulting to 7200 seconds
/ 2 hours if unspecified), add 300 seconds (5 minutes) of cleanup grace,
and use the sum as the Secrets Manager TTL on the staged inline secret.

The cleanup grace covers the worker's SIGTERM trap and lifecycle-event
emission window, plus the pangolin-client side's `awaitExit` + explicit
secret deletion path (§7.6). If both of those succeed, the secret is
deleted explicitly and the TTL is irrelevant. If catastrophic failure
occurs (worker host crash, network partition between pangolin-client and
Secrets Manager, etc.), the TTL ensures Secrets Manager auto-deletes
without operator intervention.

Explicit `ttlSeconds` overrides apply only when integrators need a
**shorter** compliance-driven lifetime — e.g., a regulated buyer whose
secret-rotation policy mandates 15-minute maximum staging windows. The SDK
does not enforce "override must be shorter than auto-computed"; integrators
who pass a longer value get what they asked for, but the documented use
case is shorter.

## Consequences

- Integrators stop hand-sizing TTLs. The common case is zero
  configuration; the override is documented for the narrow compliance case.
- The TTL is always consistent with the dispatch's actual timeout. A
  dispatch with `timeoutSeconds: 600` (10 min) gets a 15-minute TTL on its
  inline secrets; a dispatch with the default 2-hour timeout gets a
  2-hour-5-minute TTL. The relationship is mechanical and predictable.
- Catastrophic-failure recovery is bounded. The worst-case window in which
  a staged secret outlives its dispatch is the cleanup grace (5 minutes)
  plus Secrets Manager's own deletion lag (typically seconds). No
  indefinite secret leaks from worker crashes.
- The default 7200-second dispatch timeout becomes load-bearing for TTL
  sizing. Changing that default in a future release is a coupled change
  with the inline-secret behavior — flag for review at v0.2 if either
  number is reconsidered.
- Compliance-driven override path remains as the documented escape hatch.
  Integrators with rotation-policy requirements (e.g., 15-minute maximum
  staging) pass an explicit `ttlSeconds` shorter than the auto-computed
  value. The auto-compute does not silently win over an explicit shorter
  override.
