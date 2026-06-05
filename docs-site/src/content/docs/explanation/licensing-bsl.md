---
title: Licensing & BSL
description: What the Business Source License 1.1 means for you — what you can do, the one restriction, when it converts, and why agora chose BSL.
sidebar:
  order: 5
---

Agora is source-available (BSL) — it is **not** open source. The Business Source
License 1.1 is not an OSI-approved open source license; the full terms are at
[mariadb.com/bsl11](https://mariadb.com/bsl11/).

## What you can do

You are free to self-host Agora, use it internally for development, evaluation,
and your own production workloads, and modify the source.

## The restriction (today)

You may not offer Agora itself, or a product derived from it, to third parties as
a hosted or managed orchestration / agent-dispatch service. In plain terms: you
can run it for yourself; you cannot productise it as a service you sell or
provide to others. The [`LICENSE`](https://github.com/quarrysystems/agora/blob/main/LICENSE)
file is always the authoritative statement of what is and isn't permitted — this
page is a plain-language summary, not the grant.

## Embedding Agora in a product you ship?

If you're building Agora into a product or service delivered to third parties —
hosted **or** self-hosted — get in touch about commercial licensing. It keeps you
on solid footing as the project's grant evolves toward a clean "free to build,
pay to ship" line, and it's how the engine stays sustainably maintained.
[Talk to us about a commercial license or pilot →](/agora/commercial/).

## When does it convert?

On the Change Date (2030-06-01) each version of Agora automatically converts to
the Apache License, Version 2.0, which is a standard permissive open source
license.

**Policy note:** the Change Date advances with major releases per BSL customary
practice; the date stated in [`LICENSE`](https://github.com/quarrysystems/agora/blob/main/LICENSE)
is always the authoritative value (currently 2030-06-01, four years from first
publish).

## Full terms

See the [`LICENSE`](https://github.com/quarrysystems/agora/blob/main/LICENSE) file
in this repository, which incorporates the Business Source License 1.1 by
reference from [mariadb.com/bsl11](https://mariadb.com/bsl11/), together with the
Parameters (Licensor, Licensed Work, Additional Use Grant, Change Date, and
Change License) stated there.

## Why BSL? (the rationale)

agora was first licensed under the Functional Source License 1.1, MIT Future
License (`FSL-1.1-MIT`). The offload V1 work swapped it to BSL 1.1
([ADR-0017](/agora/explanation/decisions/0017-source-available-bsl/)). The
decision turned on **adoption friction** for the users V1 targets: self-hosters
and security/compliance-conscious teams running agents against their own repos,
credentials, and regulated data.

- FSL's **"Competing Use"** restriction is broad and somewhat fuzzy. A company
  with an internal agent platform has to stop and ask "is this a competing
  use?" — and that hesitation is exactly where an evaluation stalls.
- BSL's restriction is **narrow and explicit**: the Additional Use Grant forbids
  only *offering Agora (or a derivative) as a hosted or managed orchestration /
  agent-dispatch service*. A team evaluating Agora to run their own agents reads
  that and immediately knows they're clear.
- BSL is the **recognized incumbent** (MariaDB, CockroachDB, Sentry, HashiCorp) —
  lower legal-review friction than the newer FSL.
- BSL's "no hosted service" line **maps onto the architecture already built**:
  the §10.6 `client`/`service` [privilege split](/agora/explanation/privilege-boundary/)
  is the commercial boundary, and the future hosted multi-tenant control plane is
  the `service` side.

The trade-off, taken deliberately: BSL (with our grant) offers less aggressive
competitive protection than FSL and a longer closed horizon (4 years → Apache-2.0
versus FSL's 2 years → MIT). For an early-stage project optimizing for getting
real users, reducing evaluation friction beats maximizing protection.

All public copy says **"source-available (BSL)"** — never "open source," because
BSL is not OSI-approved.

## See also

- [ADR-0017 — Agora is source-available under BSL 1.1](/agora/explanation/decisions/0017-source-available-bsl/)
- [The privilege boundary](/agora/explanation/privilege-boundary/) — the `client`/`service` split that is also the commercial boundary.
</content>
