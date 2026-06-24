import type { Pattern, QuorumConfig, SpawnTemplate } from '../contracts/pattern.js';
import type { ItemState, WorkItem } from '../contracts/types.js';
import { parseAttempt } from './respawn.js';

/** Reviewer id space: `<subjectId>::rev-<index>`. The separator never collides with the
 *  `~N` round suffix on a subject id, so rounds stay isolated (`draft::rev-0` vs `draft~2::rev-0`). */
const REV_SEP = '::rev-';
const COMMIT_SUFFIX = '::commit';

const TERMINAL = new Set(['done', 'failed', 'skipped', 'cancelled']);

/** A reviewer approves iff it completed AND did not self-report a failing verdict.
 *  Mirrors the pipeline gate's red/green convention (verify.passed === false === reject). */
const approves = (r: ItemState): boolean => r.status === 'done' && r.verify?.passed !== false;

/** Validate a QuorumConfig; throw a descriptive Error (fail-fast at submit) if malformed. */
function assertQuorumConfig(cfg: unknown): void {
  if (cfg === null || typeof cfg !== 'object') {
    throw new Error('quorum: config must be a non-null object');
  }
  const c = cfg as Record<string, unknown>;

  if (!Array.isArray(c['reviewers']) || c['reviewers'].length === 0) {
    throw new Error('quorum: reviewers must be a non-empty array of templates');
  }
  for (const [i, t] of (c['reviewers'] as unknown[]).entries()) {
    assertTemplate(t, `reviewers[${i}]`);
  }

  const n = (c['reviewers'] as unknown[]).length;
  const threshold = c['threshold'];
  if (
    typeof threshold !== 'number' ||
    !Number.isInteger(threshold) ||
    threshold < 1 ||
    threshold > n
  ) {
    throw new Error(
      `quorum: threshold must be an integer in 1..${n} (reviewer count), got ${String(threshold)}`,
    );
  }

  assertTemplate(c['commit'], 'commit');

  const onReject = c['onReject'] ?? 'spawn-fix';
  if (onReject !== 'spawn-fix' && onReject !== 'block') {
    throw new Error(`quorum: onReject must be 'spawn-fix' or 'block', got ${String(onReject)}`);
  }
  if (onReject === 'spawn-fix') {
    assertTemplate(c['fixTemplate'], 'fixTemplate');
  }
}

function assertTemplate(t: unknown, label: string): void {
  if (t === null || typeof t !== 'object') {
    throw new Error(`quorum: ${label} template is required and must be an object`);
  }
  const tt = t as Record<string, unknown>;
  if (typeof tt['executor'] !== 'string') {
    throw new Error(`quorum: ${label}.executor is required and must be a string`);
  }
  if (tt['inputs'] === null || typeof tt['inputs'] !== 'object') {
    throw new Error(`quorum: ${label}.inputs is required and must be an object`);
  }
}

/** Materialize a WorkItem from a SpawnTemplate plus the caller-supplied edges. */
function itemFromTemplate(
  id: string,
  t: SpawnTemplate,
  edges: { depends_on: string[]; needs: WorkItem['needs'] },
): WorkItem {
  return {
    id,
    executor: t.executor,
    inputs: t.inputs,
    ...(t.subagentShape !== undefined ? { subagentShape: t.subagentShape } : {}),
    depends_on: edges.depends_on,
    resourceLocks: t.resourceLocks ?? [],
    ...(edges.needs ? { needs: edges.needs } : {}),
  };
}

export const quorum: Pattern = {
  id: 'quorum',

  /** Validate every subject's quorum config; pass the run through unchanged (fail-fast). */
  plan: (run) => {
    for (const it of run.items) {
      if (it.inputs['quorum'] !== undefined) assertQuorumConfig(it.inputs['quorum']);
    }
    return run;
  },

  onTaskDone: (item, ctx) => {
    if (item.status === 'cancelled') return null; // operator intent — never resurrect

    // Phase 1 — cause is a SUBJECT (carries inputs.quorum) that completed: fan out reviewers.
    if (item.inputs?.['quorum'] !== undefined && item.status === 'done') {
      const cfg = item.inputs['quorum'] as QuorumConfig;
      return {
        items: cfg.reviewers.map((t, i) =>
          itemFromTemplate(`${item.id}${REV_SEP}${i}`, t, {
            depends_on: [item.id],
            needs: { work: { from: item.id, select: { kind: 'patch' } } },
          }),
        ),
      };
    }

    // Phase 2 — cause is a REVIEWER (`<subjectId>::rev-<i>`): tally once all peers are terminal.
    const sep = item.id.indexOf(REV_SEP);
    if (sep === -1) return null;
    const subjectId = item.id.slice(0, sep);

    const subject = ctx.runItems.find((i) => i.id === subjectId);
    if (!subject || subject.inputs['quorum'] === undefined) return null;
    const cfg = subject.inputs['quorum'] as QuorumConfig;

    const reviewers = ctx.runItems.filter((i) => i.id.startsWith(`${subjectId}${REV_SEP}`));
    if (reviewers.length < cfg.reviewers.length) return null; // not all spawned yet
    if (!reviewers.every((r) => TERMINAL.has(r.status))) return null; // still reviewing
    if (reviewers.some((r) => r.status === 'cancelled')) return null; // operator intent

    const byId = new Map(ctx.runItems.map((i) => [i.id, i]));
    const commitId = `${subjectId}${COMMIT_SUFFIX}`;
    if (byId.has(commitId)) return null; // already advanced (idempotent across re-scans)

    const approvals = reviewers.filter(approves).length;

    // Quorum reached — advance to the audited commit step.
    if (approvals >= cfg.threshold) {
      return {
        items: [
          itemFromTemplate(commitId, cfg.commit, {
            depends_on: [subjectId],
            needs: { work: { from: subjectId, select: { kind: 'patch' } } },
          }),
        ],
      };
    }

    // Sub-threshold — reject.
    if ((cfg.onReject ?? 'spawn-fix') !== 'spawn-fix') return null; // 'block': rejection is final
    if (!cfg.fixTemplate) return null;

    const { base, attempt } = parseAttempt(subjectId);
    if (attempt > (cfg.maxRounds ?? 1)) return null; // circle-back bound reached

    const fixId = `${base}-fix-${attempt}`;
    const nextSubjectId = `${base}~${attempt + 1}`;
    if (byId.has(nextSubjectId)) return null; // already circled back this round

    const fixItem = itemFromTemplate(fixId, cfg.fixTemplate, {
      depends_on: [subjectId],
      needs: { work: { from: subjectId, select: { kind: 'patch' } } },
    });
    // Re-review copy: carries inputs.quorum forward so Phase 1 re-fans-out once it completes.
    const subjectCopy: WorkItem = {
      id: nextSubjectId,
      executor: subject.executor,
      inputs: subject.inputs,
      ...(subject.subagentShape !== undefined ? { subagentShape: subject.subagentShape } : {}),
      depends_on: [fixId],
      resourceLocks: subject.resourceLocks,
      needs: { work: { from: fixId, select: { kind: 'patch' } } },
    };
    return { items: [fixItem, subjectCopy] };
  },
};
