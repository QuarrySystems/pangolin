import { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import {
  OperationsApi, nextDueAfter, validateRun, normalizeRun,
  buildRunView, renderRunView, nextFrame, renderVerification,
  pipeline, mapReduce, staticDag,
} from '@quarry-systems/pangolin-orchestrator';
import type {
  SubmissionTransport, ControlChannel, AuditAnchor, Signature, ScheduleStore, Schedule, Run,
  Pattern, StatusLike,
} from '@quarry-systems/pangolin-orchestrator';
import { parsePangolinUri, buildDispatchRecordUri } from '@quarry-systems/pangolin-core';
import type { RuntimeUsage } from '@quarry-systems/pangolin-core';
import type { CliContext } from './index.js';

/** Config-owned operator wiring. Client verbs use transport(+anchor/storage); `serve` uses runService. */
export interface OrchContext {
  transport: SubmissionTransport & ControlChannel;
  anchor?: AuditAnchor;
  storage?: { get(ref: string): Promise<Uint8Array> };
  verifySignature?: (root: Uint8Array, sig: Signature) => boolean;
  runService?: (signal: AbortSignal) => Promise<void>;   // pre-wired serve() for the `serve` verb
  scheduleStore?: ScheduleStore;   // config-owned; required for `schedule` verbs
}

const resolveActor = (flag?: string): string => flag ?? process.env.PANGOLIN_ACTOR ?? `human:${userInfo().username}`;

/** Named --pattern values → the real exported Pattern objects (spec §3 — `OrchContext`
 *  carries no queue/pattern wiring, so the flag is the v1 layout-selection path). */
const PATTERNS: Record<string, Pattern> = { pipeline, 'map-reduce': mapReduce, 'static-dag': staticDag };

/** Post-terminal audit-summary retry bounds (the export publishes after the terminal
 *  status record — same driver iteration or a tick later). Env vars override for tests. */
const AUDIT_RETRIES = 15;
const AUDIT_RETRY_MS = 1000;

/** Resolve a --pattern flag value; reports a clean CLI error (validate-style) on unknown names. */
function resolvePattern(name: string | undefined, verb: string): { ok: true; pattern?: Pattern } | { ok: false } {
  if (name === undefined) return { ok: true };
  const pattern = PATTERNS[name];
  if (!pattern) {
    console.error(`${verb}: unknown pattern '${name}' — expected one of: ${Object.keys(PATTERNS).join(', ')}`);
    process.exitCode = 1;
    return { ok: false };
  }
  return { ok: true, pattern };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function attachOrchCmd(program: Command, ctx: CliContext): void {
  const o = program.command('orch').aliases(['orchestrator']).description('Submit, follow, cancel, and audit offload runs');

  o.command('submit <plan.json>').option('--queue <name>').option('--actor <id>').action(async (file, opts) => {
    const oc = await ctx.getOrchContext();
    const run = JSON.parse(await readFile(file, 'utf8'));
    if (opts.queue) run.queue = opts.queue;
    console.log(await new OperationsApi(oc).submit(run, resolveActor(opts.actor)));
  });

  o.command('validate <plan.json>').description('Statically validate a run plan (structure, edges, cycles)').action(async (file) => {
    let run: unknown;
    try {
      run = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      console.error(`validate: cannot read plan — ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    const normalized = normalizeRun(run as Run);
    const errors = validateRun(normalized);
    if (errors.length) {
      for (const e of errors) console.error(e);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ valid: true, items: normalized.items.length }));
  });

  o.command('status [run-id]').action(async (runId) => {
    const rec = await new OperationsApi(await ctx.getOrchContext()).status(runId);
    console.log(JSON.stringify(rec ?? null, null, 2));
  });

  o.command('render <plan.json>')
    .description('Render the pre-run view of a plan (ghost arcs dotted); needs no config file')
    .option('--pattern <name>', `layout pattern: ${Object.keys(PATTERNS).join(' | ')}`)
    .option('--no-color', 'disable ANSI color')
    .option('--ascii', 'pure-ASCII glyphs')
    .action(async (file, opts) => {
      // MUST NOT call ctx.getOrchContext() — render works without a config file (spec §3).
      let plan: Run;
      try {
        plan = JSON.parse(await readFile(file, 'utf8'));
      } catch (err) {
        console.error(`render: cannot read plan — ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      const resolved = resolvePattern(opts.pattern, 'render');
      if (!resolved.ok) return;
      let lines: string[];
      try {
        lines = renderRunView(
          buildRunView({ plan, ...(resolved.pattern ? { pattern: resolved.pattern } : {}) }),
          { color: process.stdout.isTTY === true && opts.color !== false, unicode: opts.ascii !== true },
        );
      } catch (err) {
        // pattern.plan() may throw on malformed config — surface it validate-style.
        console.error(`render: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      console.log(lines.join('\n'));
    });

  o.command('watch <run-id>')
    .description('Follow a run live until it reaches a terminal state (Ctrl-C to stop)')
    .option('--json', 'raw record stream (one JSON line per poll — the pre-view format)')
    .option('--interval <ms>', 'poll interval in milliseconds')
    .option('--no-color', 'disable ANSI color')
    .option('--no-clear', 'append frames instead of redrawing in place')
    .option('--ascii', 'pure-ASCII glyphs')
    .option('--pattern <name>', `layout pattern: ${Object.keys(PATTERNS).join(' | ')}`)
    .action(async (runId, opts) => {
      const oc = await ctx.getOrchContext();
      const api = new OperationsApi(oc);

      if (opts.json) {
        for await (const rec of api.watch(runId)) {
          console.log(JSON.stringify(rec));   // render each status update until terminal
        }
        return;
      }

      const resolved = resolvePattern(opts.pattern, 'watch');
      if (!resolved.ok) return;
      const color = process.stdout.isTTY === true && opts.color !== false;
      const unicode = opts.ascii !== true;
      const intervalMs = opts.interval !== undefined ? Number(opts.interval) : undefined;

      const evidence = new Map<string, RuntimeUsage>();
      const evidenceTried = new Set<string>();   // cached per item id — one fetch attempt each
      let prev: string[] | undefined;

      for await (const rec of api.watch(runId, intervalMs !== undefined ? { intervalMs } : undefined)) {
        // api.watch can yield duplicates and, before the first status publishes,
        // non-status kinds (the status() fallback) — only status arrays render.
        if (rec.kind !== 'status' || !Array.isArray(rec.body)) continue;
        const status = rec.body as StatusLike[];

        // Evidence: best-effort per done item with a manifestRef. The namespace comes
        // FROM the manifestRef itself; oc.storage may be absent; any throw → skip silently.
        // Fetches are issued concurrently so the stall is bounded by the slowest single
        // fetch rather than the sum of all fetch latencies.
        if (oc.storage) {
          const pending = status
            .filter((s) => s.status === 'done' && s.manifestRef !== undefined && !evidenceTried.has(s.id))
            .map((s) => {
              evidenceTried.add(s.id);
              return (async () => {
                try {
                  const p = parsePangolinUri(s.manifestRef!);
                  const bytes = await oc.storage!.get(buildDispatchRecordUri(p.namespace, p.name, 'output.json'));
                  const usage = (JSON.parse(new TextDecoder().decode(bytes)) as { usage?: RuntimeUsage }).usage;
                  if (usage !== undefined) evidence.set(s.id, usage);
                } catch { /* best-effort — never fail the watch */ }
              })();
            });
          await Promise.all(pending);
        }

        // No plan file in scope — synthesize a Run from the status items themselves
        // (depends_on ships on StatusItem; the tree layout is always correct).
        const plan: Run = {
          id: runId,
          queue: 'default',
          items: status.map((s) => ({
            id: s.id, executor: 'dispatch', inputs: {}, depends_on: s.depends_on ?? [], resourceLocks: [],
          })),
        };
        const view = buildRunView({ plan, ...(resolved.pattern ? { pattern: resolved.pattern } : {}), status, evidence });
        const frame = nextFrame(prev, renderRunView(view, { color, unicode }));
        if (frame === null) continue;
        if (opts.clear !== false && prev !== undefined) {
          // Redraw in place: cursor up then clear to end. console.log(frame.join('\n'))
          // emits frame.length lines plus one trailing newline, occupying prev.length+1
          // terminal rows. Rewind by prev.length+1 to avoid the ghost-top-line bug.
          process.stdout.write(`\x1b[${prev.length + 1}A\x1b[0J`);
        }
        console.log(frame.join('\n'));
        prev = frame;
      }

      // Terminal: bounded retry for the audit summary (the export publishes after
      // the terminal status record). Exit code untouched — matches prior watch behavior.
      const retries = Number(process.env.PANGOLIN_WATCH_AUDIT_RETRIES ?? AUDIT_RETRIES);
      const retryMs = Number(process.env.PANGOLIN_WATCH_AUDIT_RETRY_MS ?? AUDIT_RETRY_MS);
      for (let i = 0; i < retries; i++) {
        try {
          const bundle = await api.audit(runId);
          console.log(renderVerification(bundle, { color }));
          return;
        } catch {
          if (i < retries - 1) await sleep(retryMs);
        }
      }
      console.log('(no audit export published — run may not be sealed)');
    });

  o.command('cancel <target>').option('--actor <id>').action(async (target, opts) => {
    await new OperationsApi(await ctx.getOrchContext()).cancel(target, resolveActor(opts.actor));
    console.log(`cancel requested: ${target}`);
  });

  o.command('audit <run-id>').option('--out <path>').action(async (runId, opts) => {
    const bundle = await new OperationsApi(await ctx.getOrchContext()).audit(runId);
    const json = JSON.stringify(bundle, null, 2);
    if (opts.out) await writeFile(opts.out, json); else console.log(json);
    if (!bundle.report.intact) process.exitCode = 1;   // audit failure → nonzero exit
  });

  o.command('serve').action(async () => {
    const oc = await ctx.getOrchContext();
    if (!oc.runService) throw new Error('pangolin orch serve: pangolin.config `orch` export provides no runService');
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    process.on('SIGINT', onAbort);
    process.on('SIGTERM', onAbort);
    try {
      await oc.runService(ac.signal);
    } finally {
      process.off('SIGINT', onAbort);
      process.off('SIGTERM', onAbort);
    }
  });

  const sched = o.command('schedule').description('Manage recurring submissions');

  sched.command('add')
    .requiredOption('--id <id>')
    .requiredOption('--cron <expr>')
    .requiredOption('--plan <plan.json>')
    .option('--actor <id>')
    .action(async (opts) => {
      const oc = await ctx.getOrchContext();
      if (!oc.scheduleStore) throw new Error('pangolin orch schedule: pangolin.config `orch` export provides no scheduleStore');
      const nextDueAt = nextDueAfter(opts.cron, Date.now());   // validates the expr (throws on bad cron)
      const run = JSON.parse(await readFile(opts.plan, 'utf8'));
      const s: Schedule = { id: opts.id, cronExpr: opts.cron, run, actor: resolveActor(opts.actor), nextDueAt };
      oc.scheduleStore.upsert(s);
      console.log(`schedule '${opts.id}' next due ${nextDueAt}`);
    });

  sched.command('list').action(async () => {
    const oc = await ctx.getOrchContext();
    if (!oc.scheduleStore) throw new Error('pangolin orch schedule: pangolin.config `orch` export provides no scheduleStore');
    for (const s of oc.scheduleStore.list()) {
      console.log(`${s.id}\t${s.cronExpr}\tlast=${s.lastFiredAt ?? '-'}\tnext=${s.nextDueAt}`);
    }
  });

  sched.command('rm')
    .requiredOption('--id <id>')
    .action(async (opts) => {
      const oc = await ctx.getOrchContext();
      if (!oc.scheduleStore) throw new Error('pangolin orch schedule: pangolin.config `orch` export provides no scheduleStore');
      oc.scheduleStore.remove(opts.id);
      console.log(`schedule '${opts.id}' removed`);
    });
}
