---
title: Schedule recurring runs
description: Wire a `scheduleStore` into your pangolin.config, register a cron schedule, and let `serve` fire it automatically.
---

`pangolin orch submit` fires a run once. When you want to run the same plan on a
recurring schedule — nightly, hourly, weekly — wire a `scheduleStore` into your
config and use `pangolin orch schedule add`. The `serve` driver polls due schedules
on each tick and submits them through the same inbox a client uses; no external
scheduler is required.

## 1. Wire a `scheduleStore` into your config

Open your `pangolin.config.mjs` (or `.ts`/`.js`) and add a `SqliteScheduleStore`
to the `orch` export. Pass it the **same database path** as your
`SqliteRunStateStore` — they share one SQLite file:

```javascript
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SqliteRunStateStore,
  SqliteScheduleStore,
  serve,
} from '@quarry-systems/pangolin-orchestrator';

const dbPath = join(tmpdir(), 'my-orchestrator.db');
const store = new SqliteRunStateStore(dbPath);
const scheduleStore = new SqliteScheduleStore(dbPath);

// ... orchestrator / transport setup unchanged ...

export const orch = {
  transport,
  runService: (signal) => serve({ orchestrator, transport, scheduler, signal }),
  scheduleStore,   // <-- add this
};
```

Without `scheduleStore`, the `pangolin orch schedule` verbs error immediately with
a clear message; `serve` and all other `orch` verbs are unaffected.

## 2. Add a schedule

```bash
pangolin orch schedule add \
  --id nightly-audit \
  --cron "0 2 * * *" \
  --plan ./plans/audit.json
```

`--cron` accepts a standard 5-field cron expression (`min hour dom mon dow`,
UTC). The command validates the expression up front and rejects invalid syntax
before writing anything. On success it prints the id and the first `nextDueAt`:

```
schedule 'nightly-audit' next due 2026-06-04T02:00:00.000Z
```

Re-running `add` with the same `--id` is an idempotent update — the expression,
plan template, and actor are replaced, and the `nextDueAt` is recomputed.

## 3. Confirm the schedule

```bash
pangolin orch schedule list
```

Prints a tab-delimited line per schedule:

```
nightly-audit   0 2 * * *   last=-   next=2026-06-04T02:00:00.000Z
```

`last=-` means the schedule has not fired yet; once it fires, `last` shows the
ISO timestamp of the most recent slot.

## 4. Start `serve` and let it fire

```bash
pangolin orch serve
```

`serve` polls due schedules on each tick (default 2 s). When a schedule's
`nextDueAt` is reached, `serve` submits the plan to the inbox with a
deterministic run id `<scheduleId>@<slotISO>` — for example,
`nightly-audit@2026-06-04T02:00:00Z`. The run then flows through the normal
`pollInbox → ManualTrigger → tick` pipeline unchanged.

After firing, `serve` advances `nextDueAt` to the next slot and records
`lastFiredAt`. The schedule persists across restarts — if `serve` is down when
a slot falls due, it fires **one coalesced catch-up run** (for the most-recently
missed slot) on the next startup, then resumes the normal cadence. Earlier
missed slots are dropped, not replayed.

### Release the store on shutdown

`SqliteScheduleStore` holds an open SQLite handle (like `SqliteRunStateStore`).
When `serve` returns — i.e. after the `SIGINT`/`SIGTERM` `AbortController` fires —
call `close()` on the store so the database file lock is released. This matters
on Windows, where an unreleased handle keeps the file locked. Close it after
`serve` resolves in your `runService`:

```js
runService: async (signal) => {
  try {
    await serve({ orchestrator, transport, scheduler, signal });
  } finally {
    scheduleStore.close();
  }
},
```

## 5. Remove a schedule

```bash
pangolin orch schedule rm --id nightly-audit
```

The schedule is removed immediately. Any run already in flight continues
normally; no new run for that schedule will be submitted. Removing an id that
does not exist is a no-op.

## Notes

- **Time zone**: cron expressions are evaluated in UTC (the host's clock). If
  you need a local time, adjust the expression for your offset or set the host
  `TZ` environment variable.
- **Minute granularity**: standard 5-field cron is minute-granular. Sub-minute
  schedules are not supported.
- **Single-`serve` assumption**: schedule state lives in the same SQLite DB as
  run state — one `serve` is the sole writer, matching V1's design.
- **MCP**: schedule management is an operator action and is CLI-only; no MCP
  tool surface is exposed for schedule mutation.

## See also

- [How an offload run executes](/pangolin/explanation/how-offload-runs/#recurring-submission-cron) — cron as an inbox producer, catch-up coalescing.
- [CLI reference](/pangolin/reference/cli/#pangolin-orch) — full option listing for `schedule add|list|rm`.
- [pangolin.config reference](/pangolin/reference/config/) — the `scheduleStore` field on the `orch` export.
- [Design spec](https://github.com/quarrysystems/pangolin/blob/main/docs/superpowers/specs/2026-06-02-pangolin-scale-cron-trigger-design.md) — architecture, catch-up policy, and idempotency mechanics.
