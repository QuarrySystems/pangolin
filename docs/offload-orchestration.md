# Offload orchestration (`agora orch`)

Where `agora dispatch` runs **one** unit of work now and blocks until it exits,
**offload** queues a whole DAG of work, fans it out safely across an isolated,
credential-sealed worker pool, lets it run unattended, and produces a verifiable
audit trail of exactly what ran. This guide is the operator's how-to for the
offload surface shipped in V1.

> Prerequisite: you can already do a single dispatch (see
> [Getting started](getting-started.md)). Offload composes that primitive; it
> does not replace it.

A complete, runnable reference lives at
[`examples/offload-fanout/`](../examples/offload-fanout) — read it alongside this
guide.

---

## 1. The model: Queue / Run / WorkItem

- **Queue** — a long-lived named bucket with a concurrency budget. V1 registers
  one queue, `default`. The unit of "how much runs at once."
- **Run** — one plan submission: a set of **WorkItems** plus their `depends_on`
  edges. Lives until every item is terminal.
- **WorkItem** — one dispatchable unit (a subagent + inputs), with `depends_on`
  edges and `resourceLocks`.

**Safe parallelism comes from two independent mechanisms:**

- `depends_on` — DAG ordering. An item does not become eligible until all its
  dependencies are `done`.
- `resourceLocks` — file-level mutual exclusion *within* a queue. Items holding
  **disjoint** locks fan out to the queue's concurrency; items contending for a
  **shared** lock serialize. (E.g. "rename a symbol across the repo" → one item
  per file, a lock per file → maximal safe parallelism; anything touching a
  shared `package.json` serializes against everything else that touches it.)

---

## 2. The two seams (and the D3 rule)

Offload is built on two storage seams, both with a local and a remote impl so
local→production is a target swap, not a rewrite:

- **`MailboxStore`** — a mutable inbox/outbox. Clients **write** a Run to the
  inbox; the service **publishes** status + the audit export to the outbox.
  *No inbound networking* — the service polls, it never listens.
- **`StorageProvider`** — content-addressed, hash-verified storage for the
  artifacts: capability/env/subagent bundles, **patch artifacts**, signed
  **dispatch manifests**, and **audit roots/proofs**.

**D3 — `serve` is the sole DB owner.** Only the `serve` daemon opens the
run-state SQLite DB and only it calls `tick()`. The CLI and MCP never touch the
DB: clients **write the inbox and read the outbox**. `audit` reads the
service-published audit export from the outbox and verifies it against the live
anchor — it does not open the DB either. This is what makes local→remote
parity a target swap and keeps the surfaces thin.

---

## 3. Wiring `agora.config`

The `agora` CLI resolves `agora.config.{ts,js,mjs}` from the current directory.
For offload it reads a named **`orch`** export — the operator-owned wiring the
client verbs translate over (mirrors how `getClient()` resolves the
`AgoraClient` for `agora dispatch`). See
[`examples/offload-fanout/agora.config.mjs`](../examples/offload-fanout/agora.config.mjs)
for a complete, runnable file. Shape:

```js
// agora.config.mjs (sketch — see the example for the full file)
export const orch = {
  // SubmissionTransport & ControlChannel — the inbox/outbox + cancel channel
  transport,
  // StorageProvider read access (for `audit` to fetch manifests by ref)
  storage,
  // AuditAnchor in force — LocalAnchor (detect) locally, S3ObjectLockAnchor remote
  anchor,
  // optional: verify the epoch root's signature (e.g. verifyEd25519 with a stable key)
  verifySignature,
  // pre-wired serve() the `serve` verb drives; the ONLY DB opener + tick() caller
  runService: (signal) => serve({ orchestrator, transport, signal }),
};
```

Deploy-specific wiring — which executor, worker image, secrets, the SQLite path,
the anchor tier — lives here in **your** config, never in the CLI. The CLI only
translates.

---

## 4. The CLI: `agora orch`

(`agora orchestrator` is an alias.)

| Command | Side | What it does |
|---|---|---|
| `agora orch serve` | service | The long-running daemon. Owns the run-state DB, polls the inbox, runs the reconcile tick loop, publishes status + the audit export, exits cleanly on SIGINT/SIGTERM. Runs inside your deployed container. |
| `agora orch submit <plan.json> [--queue <name>] [--actor <id>]` | client | Writes the Run to the inbox. Prints a run id. **Non-blocking.** |
| `agora orch status [run-id]` | client | Prints the latest status snapshot from the outbox (item tree + blocking reasons). |
| `agora orch watch <run-id>` | client | Follows the run, printing each status update until it reaches a terminal state. Ctrl-C to stop (it's a `tail -f`-style follow). |
| `agora orch cancel <run-id\|item-id> [--actor <id>]` | client, **privileged** | Requests cancellation via the control channel. CLI-only. |
| `agora orch audit <run-id> [--out <path>]` | client, **read-only** | Emits the §6.5 evidence bundle (stdout, or `--out` to a file). Exits non-zero if the bundle does not verify. **CLI-only.** |

**Actor identity (§6.4).** `submit` and `cancel` stamp an actor onto the
operation, recorded in the audit trail. Resolution order: `--actor <id>` →
`AGORA_ACTOR` env → `human:<os-username>`.

**Typical session:** run `serve` in one place; from anywhere with the same
config, `submit plan.json`, `watch <id>` until done, then `audit <id>`.

---

## 5. The plan (`plan.json`)

A Run is JSON:

```jsonc
{
  "id": "fanout-1",
  "queue": "default",
  "items": [
    { "id": "edit-alpha", "executor": "dispatch",
      "inputs": { "subagent": "code-edit", "workerInput": { "file": "alpha.ts" } },
      "depends_on": [], "resourceLocks": ["fixture/alpha.ts"] },
    { "id": "verify", "executor": "dispatch",
      "inputs": { "subagent": "verify" },
      "depends_on": ["edit-alpha"], "resourceLocks": [] }
  ]
}
```

- `inputs.subagent` names a registered subagent; `inputs.workerInput` is the
  free-form JSON forwarded to it.
- `depends_on` lists item ids that must be `done` first.
- `resourceLocks` are opaque keys (file paths by convention) that serialize
  contending items within the queue.
- Secret **values** are never in a WorkItem — deploy-time secrets are attached to
  the executor in your config (§10.6). A run-time/MCP-submitted item cannot
  supply or read a secret.

`--queue <name>` on `submit` overrides the plan's `queue`. Item statuses move
`pending → ready → running → done` (or `failed`/`skipped`/`cancelled`); a
terminally `failed` item skip-cascades its transitive dependents.

---

## 6. Results: the patch escape

The sandbox is the product — nothing leaves the container by default. On a
successful run each item captures its workspace diff, uploads it to
`StorageProvider` as a **content-addressed patch artifact**, and the executor
surfaces that ref as the item's **`result_ref`**:

```
agora://<namespace>/artifact/<dispatchId>/sha256:<hash>
```

`status`/`watch`/the audit bundle expose `result_ref` per item; fetch it through
the outbox/storage to review the patch. (A run that changes nothing produces no
`result_ref`.)

---

## 7. The evidence bundle (`agora orch audit`)

`audit` produces the §6.5 compliance artifact for an auditor or incident review:

```jsonc
{
  "runId": "...",
  "manifests": [ /* per-item signed dispatch manifests — refs only, never secret values */ ],
  "auditLog":  { "entries": [ /* hash-chained lifecycle events */ ], "root": { /* anchored, signed Merkle root */ } },
  "items":     [ { "id", "status", "attempts?", "actor?", "resultRef?", "manifestRef?" } ],
  "report":    { "runId", "intact", "anchorId", "guarantee", "claim", "failure?" }
}
```

The **verification report** is the headline: it recomputes each epoch's Merkle
root from the entries, fetches the anchored root from the **live anchor**, checks
they match, and verifies the signature. It **names the anchor in force and its
guarantee tier**, so the claim is scoped to what verification can *prove*:

| `AuditAnchor` | `guarantee` | report `claim` | meaning |
|---|---|---|---|
| `LocalAnchor` (default) | `detect` | **`tamper-detecting`** | catches accidental/clumsy mutation; root lives in the same store — *not* evidence against an attacker who controls the DB. |
| `S3ObjectLockAnchor` | `external-immutable` | **`tamper-evident`** | signed root in S3 Object Lock (compliance mode), a different trust domain — survives a DB-side tamper attempt. |

**Honesty rules (enforced, not optional):** the word **"tamper-evident"** is
licensed only at `external-immutable`+; at the local tier the honest term is
**"tamper-detecting."** A mismatch — or a missing/unreachable anchored root —
drops the report to `tamper-detecting` regardless of the configured anchor. The
product is **"compliance-ready,"** never "compliant"/"certified," and agent
*output* is recorded, not reproducible (the *environment + inputs* are
reproducible by hash). `audit` exits non-zero when `report.intact` is false.

`audit` is **CLI-only and read-only** — auditing is an operator action, not an
AI-loop action, so it is never exposed on MCP.

---

## 8. The privilege model (§10.6) — why the MCP surface is narrow

All operator logic lives in one operations API; the CLI and MCP are thin
translators over it, and each method carries a privilege tag the surfaces
cannot override:

| Operation | Tag | CLI | MCP |
|---|---|---|---|
| `submit` / `status` / `watch` | `client` | ✓ | ✓ |
| `cancel` | `privileged` | ✓ | ✗ |
| `audit` | `client`, read-only | ✓ | ✗ (operator action) |
| `serve` / `tick` | `service` | ✓ | ✗ |

So a run-time agent (via `agora_orchestrator_submit`/`_status`/`_watch`) can
offload work and follow it, but **cannot** cancel another agent's run,
audit, or run the daemon. A CI check (`scripts/check-mcp-tool-allowlist.mjs`)
**fails the build** if any privileged/service method — or `audit` — becomes
reachable over MCP. (Ownership-scoped agent cancel is a V1.1 item, gated on the
`Authorizer` seam.)

---

## 9. Local → production parity

The same `plan.json` and the same code path run against the local Docker stack
and against Fargate + S3 — you swap only the target, storage, and anchor in your
`agora.config`:

| Concern | Local | Production |
|---|---|---|
| compute | `LocalDockerProvider` | `FargateProvider` |
| storage / mailbox | local FS | S3 |
| audit anchor | `LocalAnchor` (→ `tamper-detecting`) | `S3ObjectLockAnchor` (→ `tamper-evident`) |
| run-state DB | named Docker volume | EBS/EFS on the service |

Deployment reuses `agora deploy` — the orchestrator is just another container
image. Self-host is also the compliance posture: regulated data never leaves
your account; route the model call through Amazon Bedrock to keep it inside your
AWS BAA boundary (the Bedrock `RuntimeAdapter` is additive, deferred).

---

## See also

- [Architecture overview](architecture-overview.md) — one rendered diagram of the whole agora process (this orchestrated path shown alongside single `dispatch`, the sandbox, and the audit spine).
- [`examples/offload-fanout/`](../examples/offload-fanout) — the runnable §7 demo.
- [Orchestrator architecture spec](superpowers/specs/2026-05-28-agora-orchestrator-design.md) — registries, queues/deps/locks, the operations-API consolidation.
- [Offload V1 delivery spec](superpowers/specs/2026-05-29-agora-offload-v1-design.md) — the shipped V1 slice, the audit/compliance edge, and the honesty constraints.
- [ADR-0005](decisions/0005-privileged-ops-never-ai-reachable.md), [ADR-0017](decisions/0017-source-available-bsl.md).
