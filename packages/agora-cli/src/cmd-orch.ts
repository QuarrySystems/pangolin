import { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { OperationsApi, nextDueAfter } from '@quarry-systems/agora-orchestrator';
import type { SubmissionTransport, ControlChannel, AuditAnchor, Signature, ScheduleStore, Schedule } from '@quarry-systems/agora-orchestrator';
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

const resolveActor = (flag?: string): string => flag ?? process.env.AGORA_ACTOR ?? `human:${userInfo().username}`;

export function attachOrchCmd(program: Command, ctx: CliContext): void {
  const o = program.command('orch').aliases(['orchestrator']).description('Submit, follow, cancel, and audit offload runs');

  o.command('submit <plan.json>').option('--queue <name>').option('--actor <id>').action(async (file, opts) => {
    const oc = await ctx.getOrchContext();
    const run = JSON.parse(await readFile(file, 'utf8'));
    if (opts.queue) run.queue = opts.queue;
    console.log(await new OperationsApi(oc).submit(run, resolveActor(opts.actor)));
  });

  o.command('status [run-id]').action(async (runId) => {
    const rec = await new OperationsApi(await ctx.getOrchContext()).status(runId);
    console.log(JSON.stringify(rec ?? null, null, 2));
  });

  o.command('watch <run-id>').description('Follow a run until it reaches a terminal state (Ctrl-C to stop)').action(async (runId) => {
    const api = new OperationsApi(await ctx.getOrchContext());
    for await (const rec of api.watch(runId)) {
      console.log(JSON.stringify(rec));   // render each status update until terminal
    }
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
    if (!oc.runService) throw new Error('agora orch serve: agora.config `orch` export provides no runService');
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
      if (!oc.scheduleStore) throw new Error('agora orch schedule: agora.config `orch` export provides no scheduleStore');
      const nextDueAt = nextDueAfter(opts.cron, Date.now());   // validates the expr (throws on bad cron)
      const run = JSON.parse(await readFile(opts.plan, 'utf8'));
      const s: Schedule = { id: opts.id, cronExpr: opts.cron, run, actor: resolveActor(opts.actor), nextDueAt };
      oc.scheduleStore.upsert(s);
      console.log(`schedule '${opts.id}' next due ${nextDueAt}`);
    });

  sched.command('list').action(async () => {
    const oc = await ctx.getOrchContext();
    for (const s of oc.scheduleStore?.list() ?? []) {
      console.log(`${s.id}\t${s.cronExpr}\tlast=${s.lastFiredAt ?? '-'}\tnext=${s.nextDueAt}`);
    }
  });

  sched.command('rm')
    .requiredOption('--id <id>')
    .action(async (opts) => {
      const oc = await ctx.getOrchContext();
      oc.scheduleStore?.remove(opts.id);
      console.log(`schedule '${opts.id}' removed`);
    });
}
