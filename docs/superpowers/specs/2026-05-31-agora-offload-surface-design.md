---
title: Agora Offload — offload-surface wave design (operator surface)
date: 2026-05-31
status: design (approved direction; DAG plan pending)
branch: offload-surface
authors: [human:Brett, agent:claude-opus-4-8]
builds_on:
  - "[[docs/superpowers/specs/2026-05-29-agora-offload-v1-design.md]]"
  - "[[docs/superpowers/specs/2026-05-28-agora-orchestrator-design.md]]"
---

# offload-surface — the operator surface (no business logic in the surfaces)

> **Status:** wave design note. Refines the V1 canon for the fourth offload wave.
> This does **not** restate the V1 spec — it *applies* §1.1 item 5, §6.4, §6.5,
> and orchestrator §10.2/§10.4–10.6, and records the two design forks that the
> V1 spec deferred to "the plan." All D1–D11 and V1-D1–D4 decisions remain binding.

This is the fourth of five offload waves (`offload-runner` #18, `offload-escape`
#19, `offload-audit` #21 are merged). It consolidates the operations API and
exposes it via CLI + MCP — **client-only**, surfaces as pure translators — and
adds the §10.6 CI allowlist gate. The audit machinery it surfaces
(`verify(runId)`, `AuditLog`/`AuditStore`, manifests) already exists; this wave
*composes* it into the exportable evidence bundle, it does not reimplement it.

---

## 1. The principle this wave enforces (orchestrator §10.2)

**All operator-facing business logic lives in one place; every surface is a thin
translator.** CLI (`cmd-orch.ts`) and MCP (`tools.ts`) map their input format to
operations-API calls and render results. No business logic in a surface; no
surface knows about another. The §10 self-review greps `cmd-orch.ts` / `tools.ts`
for logic and moves any hit down into the API.

---

## 2. Operations API + privilege registry

### 2.1 `OperationsApi` — the single source

A single class `agora-orchestrator/src/operations-api.ts` holds the operator-facing
business logic. It is constructed **per process** with whatever dependencies that
process has:

- **Client methods** — `submit`, `status`, `watch`, `cancel`, `audit` — operate
  through `{ transport, anchor?, storage? }` and **never** open the DB (D3).
- **Service operations** — `serve`, `tick`, and cancel *ingestion*
  (`AgoraOrchestrator.cancelRun`) — are DB-bound and stay on the driver /
  `AgoraOrchestrator`. They are not part of the client `OperationsApi` surface;
  they appear in the privilege registry only so the allowlist gate can name them.

In the daemon, the service wiring is constructed with the store + orchestrator. In
the CLI/MCP client, the `OperationsApi` is constructed with the transport (+ anchor
+ storage for `audit`). Same method bodies, one source of truth.

### 2.2 Privilege registry (`contracts/privilege.ts`)

The existing `PRIVILEGE` map in `orchestrator.ts` (currently 3 entries) is
formalized and moved into `contracts/privilege.ts` as the **single** method→tag
registry — the mechanism behind the §10.6 split:

```ts
export type PrivilegeTag = 'client' | 'privileged' | 'service';
export interface MethodPolicy { tag: PrivilegeTag; mcp: boolean; }

// mcp:true  ⇔  tag === 'client' && method is not 'audit'
//   (audit is client + read-only, but a CLI-only operator action — never MCP)
export const PRIVILEGE: Record<string, MethodPolicy> = {
  submit: { tag: 'client',     mcp: true  },
  status: { tag: 'client',     mcp: true  },
  watch:  { tag: 'client',     mcp: true  },
  cancel: { tag: 'privileged', mcp: false },
  audit:  { tag: 'client',     mcp: false }, // read-only operator action
  serve:  { tag: 'service',    mcp: false },
  tick:   { tag: 'service',    mcp: false },
};
```

- **CLI** exposes `client` + `privileged` methods (+ runs `serve`).
- **MCP** exposes only methods with `mcp: true` — `submit`/`status`/`watch`.
- **`audit`** is the deliberate exception: `client`-tagged and read-only, but
  CLI-only, because auditing is an operator action, not an AI-loop action (§6.5).
- Nothing exposes a `service` method as a tool.

---

## 3. CLI — `agora orch` (`agora-cli/src/cmd-orch.ts`)

`serve | submit | status | watch | cancel | audit`, all thin translators.
`agora orch` is an alias for `agora orchestrator`.

| Verb | Side | Behaviour |
|---|---|---|
| `serve` | service | Builds the service wiring from config and runs the existing `serve()` driver loop. The only DB opener / `tick()` caller (D3). |
| `submit <plan.json> [--queue <name>]` | client | Builds a `SubmissionEnvelope` (actor + `submittedAt`), `transport.submit`, prints the run id. **Non-blocking.** |
| `status [run-id]` | client | Reads the outbox, renders the item tree + blocking reasons ("waiting on lock: …", "waiting on dep: …"). |
| `watch <run-id>` | client | Polls the outbox per tick, rendering status changes until the run is terminal. **v1 polling model** (real-time push is V2). No streaming protocol. |
| `cancel <run-id\|item-id>` | client, **privileged** | Writes a cancel control envelope (see §5). CLI-only. |
| `audit <run-id> [--out <path>]` | client, **read-only** | Emits the §6.5 evidence bundle (default: single JSON document to stdout; `--out` writes a file). **CLI-only, never MCP.** |

The non-`serve` client verbs resolve an **orch context** from `agora.config`
(exports `{ transport, anchor?, storage }` plus a serve/orchestrator factory —
mirrors today's `getClient()` for `agora dispatch`). The plan pins the exact
config export shape.

---

## 4. MCP tools (`agora-mcp/src/tools.ts`)

Add exactly three client tools, wired through the client `OperationsApi`:

- `agora_orchestrator_submit`
- `agora_orchestrator_status`
- `agora_orchestrator_watch`

`AGORA_TOOL_NAMES` is extended to include them (the tuple is load-bearing for the
CI allowlist check). `cancel`, `audit`, and `serve` are **never** registered.

---

## 5. Cancel (minimal, additive)

No cancellation primitive exists today; `run.cancelled` is a reserved-but-unused
audit-entry kind. This wave ships **minimal** cancel — mark non-terminal items
cancelled; do **not** force-kill in-flight dispatches.

- **Transport control channel.** `SubmissionTransport` gains `control(env)`
  (client write), `pollControl()` and `ackControl(id)` (service), over a
  `control/` mailbox prefix mirroring `submissions/`. Existing methods unchanged
  (purely additive; S3↔local parity preserved).
- **Core.** `AgoraOrchestrator.cancelRun(runId, actor)` (and `cancelItem`) marks
  every `pending|ready` item of the run terminally `cancelled`, runs the existing
  skip-cascade on dependents, leaves `running` items to reconcile naturally, and
  appends a `run.cancelled` audit entry with the actor. `cancelled` joins the
  terminal-status set.
- **serve.** Each loop, polls the control inbox and applies cancels **before**
  `tick()`.

**Why no force-kill, and why not on MCP.** Force-killing live containers adds a
reconcile race (finished-vs-killed) and per-executor teardown semantics the §7
demo never exercises — pull it when a real need does. Cancel stays **privileged,
CLI-only** per orchestrator §10.5/§10.6 and ADR-0005: V1 has no ownership/authz
model (the `Authorizer` seam is V1.1, V1-spec §1.2), and the MCP surface has no
per-call auth ("whoever launched"), so a `cancel(run-id)` reachable from the AI
loop could cancel **any** run — including a human's or another agent's — and
"cancel only your own" is not enforceable here. Ownership-scoped agent cancel
arrives additively in V1.1 alongside the `Authorizer` seam.

---

## 6. Audit evidence bundle (§6.5)

### 6.1 Data source — service-exported, client-verified against the live anchor

The audit entries + Merkle root live only in the run-state DB (`AuditStore`);
manifests and patch artifacts live in content-addressed `StorageProvider` by ref;
§6.3 requires verification to consult the **live external anchor**, never a stored
copy. To honour D3 ("CLI never touches SQLite") **and** local→Fargate parity (an
operator may run `audit` from a laptop, not on the EBS volume), the data is
**pushed by the service** to a client-readable location and **verified
client-side**:

1. **serve (service)** — when an epoch seals (run-completion, where it already
   seals), publish an outbox record of new kind **`audit`**:

   ```jsonc
   { runId, kind: "audit", at,
     body: {
       entries: AuditEntryRow[],          // hash-chained leaves — refs only
       root:    AnchoredRoot,             // signed/anchored epoch root + receipt
       items:   [{ id, status, attempts, actor, resultRef?, manifestRef? }]
     } }
   ```

   **Refs only — never secret values** (manifests/audit entries already record
   `secretRefs`, not values; the §7 test greps the export to prove it).

2. **`audit/bundle.ts` (NEW, engine-side, executor-agnostic)** —
   `assembleBundle(export, { anchor, storage })`:
   - reconstruct an **in-memory `AuditStore`** from `export.entries` + `export.root`;
   - fetch each `manifestRef` blob from `storage` (inline manifests by value);
   - run the **existing** `verify(runId, { store: inMemory, anchor })` against the
     **live** `anchor` the client builds from config — a tampered export
     recomputes a root that no longer matches the live anchored root, so the
     report drops to `tamper-detecting` (exactly §6.3's guarantee);
   - assemble the bundle.

3. **`OperationsApi.audit(runId)`** orchestrates only: read the export via
   `transport.readOutbox`, call `assembleBundle`. The CLI just prints/writes it.
   **Verification is never reimplemented in the CLI** (cross-system note).

### 6.2 Bundle shape

```jsonc
{
  "runId": "...",
  "manifests": [DispatchManifest, ...],     // per item, fetched by manifestRef
  "auditLog":  { "entries": AuditEntryRow[], "root": AnchoredRoot },
  "items": [{ "id", "status", "attempts", "actor", "resultRef?", "manifestRef?" }],
  "report": {                               // = verify() output, surfaced verbatim
    "runId", "intact", "anchorId", "guarantee",
    "claim": "tamper-evident" | "tamper-detecting",
    "failure?": "chain"|"anchor-missing"|"root-mismatch"|"signature"
  }
}
```

The `report` **names the anchor in force and its guarantee tier**. Copy says
`tamper-evident` only at `external-immutable`+ and `tamper-detecting` at `detect`;
never "compliant" — "compliance-ready" only.

---

## 7. §10.6 CI allowlist check (hard gate)

Extend `scripts/check-mcp-tool-allowlist.mjs` (+ `tool-allowlist.test.ts`) to be
**privilege-registry-driven**: import the built `PRIVILEGE` registry and
`AGORA_TOOL_NAMES`, map each registered MCP tool to its underlying method, and
**fail** if any maps to a method whose `mcp !== true` — i.e. any `privileged` or
`service` method, or `audit`. Keeps the existing forbidden-pattern checks. A
negative test wires a privileged method onto MCP and asserts the check fails.

---

## 8. Testing & post-wave pressure test

Per-task TDD; the per-task gate runs **both** `pnpm --filter <pkg> typecheck`
**and** `… test` (vitest's esbuild passes type errors silently — typecheck is the
real gate). Wave-level pressure tests, run against a real sealed run:

- `agora orch audit <run-id>` → bundle verifies, **names the guarantee tier**, and
  a grep for known secret material over the exported bundle **finds none** (§6.5/§10).
- The §10.6 check **fails** when a privileged method is wired to MCP (proven, not asserted by inspection).
- A `LocalAnchor` run reports `tamper-detecting`; mutating any persisted entry → `verify` fails.
- Executor-agnostic grep: `operations-api.ts`, `audit/bundle.ts`, `contracts/privilege.ts`
  carry no `subagent|model|dispatch|claude` (V1-D4).
- `cmd-orch.ts` / `tools.ts` carry no business logic (§10.2 grep).

---

## 9. File layout

```
agora-orchestrator/src/
  operations-api.ts                  [NEW]    consolidated client API + actor capture (§6.4)
  contracts/privilege.ts             [NEW]    method→{tag,mcp} registry (formalizes PRIVILEGE)
  audit/bundle.ts                    [NEW]    assembleBundle — reuses verify()
  contracts/submission-transport.ts  [EXTEND] control channel: control/pollControl/ackControl
  contracts/audit.ts                 [EXTEND] AuditBundle type
  transport/storage-transport.ts     [EXTEND] control/ prefix impl
  orchestrator.ts                    [EXTEND] cancelRun/cancelItem; 'cancelled' terminal; re-export PRIVILEGE
  serve/driver.ts                    [EXTEND] poll control inbox; publish 'audit' export on seal
  contracts/mailbox.ts / index.ts    [EXTEND] OUTBOX_KINDS += 'audit'; barrel exports

agora-cli/src/cmd-orch.ts            [NEW]    serve|submit|status|watch|cancel|audit (pure translator)
agora-cli/src/index.ts               [EXTEND] attachOrchCmd

agora-mcp/src/tools.ts               [EXTEND] +3 client tools; AGORA_TOOL_NAMES
scripts/check-mcp-tool-allowlist.mjs [EXTEND] privilege-registry-driven gate
```

No new package boundaries. Every change is additive over the existing seams.

---

## 10. Out of scope (this wave)

Force-kill of in-flight dispatches; `approve`/`queue config`/`pause`/`resume`
verbs; named queues beyond `default`; HTTP transport; the `offload-fanout` example
+ BSL packaging (that is the `offload-launch` wave). The `Authorizer` seam and
ownership-scoped MCP cancel are V1.1.
