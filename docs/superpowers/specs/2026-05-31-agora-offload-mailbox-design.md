---
title: Agora Offload — Mailbox Seam (real submission backend)
date: 2026-05-31
status: design (approved direction; implementation plan pending)
branch: docs/agora-offload-v1-spec
authors: [human:Brett, agent:claude-opus-4-8]
builds_on: "[[docs/superpowers/specs/2026-05-29-agora-offload-v1-design.md]]"
---

# Agora Offload — Mailbox Seam

> **Status:** design note. Approved direction; not yet implemented.
> Fixes the storage gap surfaced by the offload-runner pressure test: the
> `SubmissionTransport` assumes a generic, mutable, name-addressed key→bytes store
> with prefix listing, but the shipped `StorageProvider` is a **content-addressed
> artifact store**. They are different abstractions. The transport therefore only
> ever ran against hand-written fakes — it does **not** work against any real
> backend. This spec gives the transport a backend that exists.

---

## 1. The problem

The orchestrator receives work by **message-passing through a shared medium, no
direct connection** (spec D3/D5): the orchestrator is the sole owner of its DB and
has no inbound network, so a client **drops a Run in an "inbox"** and the
orchestrator **polls** it; the orchestrator **drops status in an "outbox"** and
clients poll that. That is a **mailbox**.

A mailbox needs a **mutable, name-addressed key→bytes store with prefix listing
and delete** (S3's native API, or a filesystem directory). The shipped
`StorageProvider` is the opposite — a **content-addressed** store:

| | `StorageProvider` (content-addressed) | Mailbox (needed) |
|---|---|---|
| Addressed by | content hash (`agora://ns/type/name/<sha256>`) | a chosen name (`submissions/run-7.json`) |
| Mutability | immutable, integrity-verified | mutable (consume / overwrite / delete) |
| `list` | version history of one logical name | arbitrary prefix |
| Right for | artifacts, the audit manifest | inbox / outbox / claim |

A submission inbox is inherently mutable + name-addressed; content-addressing is
immutable by construction (you can't have a mutable inbox slot or a "consumed"
flag in it). Forcing the mailbox onto `StorageProvider` is a category error — it
worked only because the unit test and pressure harness used mailbox-shaped fakes.
Against the real `LocalStorageProvider`/S3 provider, `submit()` →
`storage.put('submissions/r1.json', …)` fails (not a valid `agora://` URI). **The
runner cannot receive a submission in any real deployment.** This is the gap
between "passes tests" and "runs."

**Fix:** a dedicated narrow `MailboxStore` seam with a real local-filesystem impl,
and rewire the transport onto it. The content-addressed `StorageProvider` keeps
its job (artifacts, manifests) untouched.

## 2. Decisions

| # | Decision | Resolution |
|---|---|---|
| **M1** | New seam vs extend StorageProvider | **New `MailboxStore` seam.** The two concerns (immutable content-addressed artifacts vs mutable mailbox) are genuinely different; conflating them dilutes both. Mirrors agora's narrow-seam ethos. Lives in `agora-orchestrator/src/contracts/` (D11). |
| **M2** | Backends this wave | **`LocalDirMailbox` only** (node:fs, zero new deps, OS-safe keys) — unblocks the local/self-host stack now. `S3Mailbox` is an additive follow-up in its **own package** (`agora-mailbox-s3`) so the AWS SDK never enters `agora-orchestrator`. |
| **M3** | Claim model | **Delete-after-ingest + idempotent `submitRun`.** Under the single-owner model (D3) there is one poller; a message is consumed by deleting it *after* successful ingest (ack), and `submitRun` is a no-op for a run id already persisted, so a crash-and-re-deliver is safe (at-least-once → idempotent). No atomic primitive needed; `putIfAbsent` is deferred to a future multi-replica pass. |

## 3. The `MailboxStore` seam

```typescript
// agora-orchestrator/src/contracts/mailbox.ts
/** A mutable, name-addressed key→bytes store with prefix listing — the orchestrator
 *  submission/outbox backend. Keys are '/'-delimited logical paths. Distinct from
 *  the content-addressed StorageProvider (which stays for artifacts/manifests). */
export interface MailboxStore {
  put(key: string, bytes: Uint8Array): Promise<void>;   // write/overwrite
  get(key: string): Promise<Uint8Array | null>;          // null if absent
  list(prefix: string): Promise<string[]>;               // logical keys under prefix
  delete(key: string): Promise<void>;                    // idempotent (no-op if absent)
}
```

Minimal by intent. `put` is overwrite (last-writer-wins); `delete` is idempotent;
`list` returns logical keys (decoded — see §4). No content hashing, no integrity
verification, no version history — that is `StorageProvider`'s job, not this.

## 4. `LocalDirMailbox` (this wave)

```typescript
// agora-orchestrator/src/mailbox/local-dir.ts  — node:fs only, zero extra deps
export class LocalDirMailbox implements MailboxStore { constructor(rootDir: string) {…} }
```

- **Key ⇄ path, OS-safe.** A logical key (`outbox/run-7/000000000001.json`) maps to
  `<root>/<encoded-path>`. Each `/`-segment is percent-encoded for the Windows-
  illegal set (`< > : " \ | ? *` + control chars); `/` stays the delimiter. `list`
  reverses the encoding so callers always see the logical key. (Our own keys are
  already safe, but the seam must be robust to any key — this is the durable home
  for the "colon" finding, not the transport.)
- **`put`**: `mkdir -p` the dirname, then **atomic write** (write a temp file, then
  rename) so a crash can't leave a half-written object.
- **`get`**: read; return `null` on `ENOENT`.
- **`list(prefix)`**: recursive walk of `rootDir`, decode each file path back to its
  logical key, return those with the prefix.
- **`delete`**: `unlink`, ignore `ENOENT`.

`S3Mailbox` (deferred, own package) implements the same four methods over
`PutObject`/`GetObject`/`ListObjectsV2`/`DeleteObject` — additive, no orchestrator
change.

## 5. Transport rewire — `MailboxSubmissionTransport`

`StorageSubmissionTransport(StorageProvider)` becomes
`MailboxSubmissionTransport(MailboxStore)`. The inbox/outbox key logic is preserved
(monotonic counter for outbox keys — the fs-safe-keys work stands); the `.claimed`
marker is replaced by **delete-after-ack**:

```typescript
export interface InboxMessage { env: SubmissionEnvelope; ack(): Promise<void>; }

export interface SubmissionTransport {
  submit(env: SubmissionEnvelope): Promise<string>;     // put('submissions/<runId>.json', env)
  pollInbox(): Promise<InboxMessage[]>;                  // list+get; ack() deletes the inbox key
  publish(rec: OutboxRecord): Promise<void>;             // put('outbox/<runId>/<seq>.json', rec)
  readOutbox(runId: string): Promise<OutboxRecord[]>;    // list+get, sorted by key
}
```

`pollInbox` returns each envelope wrapped with an `ack()` that deletes its inbox
key. The serve loop ingests **then** acks (at-least-once); a crash between ingest
and ack re-delivers the message, which `submitRun` (idempotent, §6) absorbs. This
is the standard message-queue ack pattern and removes the previous `.claimed`-marker
hack and its TOCTOU.

## 6. Idempotent `submitRun`

```typescript
submitRun(run: Run, actor?: string): string {
  if (this.store.getItems(run.id).length > 0) return run.id;   // already ingested — no-op
  // …existing saveRun(run, actor) + markReady…
}
```

Makes re-delivery safe and the whole ingest path crash-tolerant.

## 7. Serve loop change

```
for (const msg of await transport.pollInbox()) { orchestrator.submitRun(msg.env.run, msg.env.actor); await msg.ack(); }
```

Ingest-then-ack. Everything else in the serve loop (recover-stranded, tick, publish,
error-guard) is unchanged.

## 8. Scope

**In (this wave):** `MailboxStore` seam; `LocalDirMailbox`; rewire the transport to
`MailboxStore` + `InboxMessage`/ack; idempotent `submitRun`; serve ingest-then-ack;
update package exports; an **integration test that drives the runner end-to-end
against a real `LocalDirMailbox` (a temp dir)** — not a fake.

**Deferred (additive, own work):** `S3Mailbox` (`agora-mailbox-s3` package, isolates
the AWS dep); `putIfAbsent` atomic claim (multi-replica); any outbox retention/GC.

## 9. Acceptance

- The runner runs **end-to-end against a real `LocalDirMailbox`**: `submit` → `serve`
  ingests → run completes → `readOutbox` shows status. (The pressure-test path moves
  off the hand-rolled `fileStorage` onto the real seam.)
- A logical key containing a Windows-illegal char (`:`) round-trips through
  `LocalDirMailbox` put/list/get on any OS.
- Ingest is crash-tolerant: a message re-delivered after a missing ack is ingested
  exactly once (idempotent `submitRun`); `delete` is idempotent.
- `MailboxStore.{put,get,list,delete}` semantics covered by unit tests; the transport
  passes its existing behavior tests against a `MailboxStore` (fake or LocalDir).
- Full suite + typecheck + build + lint green.

## 10. Implementation staging (for the follow-on DAG plan)

Roughly: `mailbox-seam` (contract) → `local-dir-mailbox` (impl) ∥ `submitrun-idempotent`
(orchestrator) → `transport-rewire` (MailboxStore + ack) → `serve-ack` (loop) →
`exports` + `mailbox-integration` (real-LocalDir end-to-end, and migrate the pressure
test onto it). Small wave; `S3Mailbox` is a separate effort.
