// FAKE RUNTIME — a scripted RuntimeAdapter that drives the dogfood-gated DAG
// end-to-end WITHOUT calling Claude (zero AI credits).
//
// Why this exists: the only package that spends money is pangolin-runtime-
// claude-code (the real `claude` CLI behind the RuntimeAdapter seam). Everything
// the gated run actually validates — the pattern engine's red-arc circle-back,
// patch capture, the subagent-level verify gate, seal/audit/hash-chain, and the
// §4 acceptance rows — is model-INDEPENDENT. Swap a fake at the seam and the rest
// of the worker lifecycle (baseline → diff → verify → sentinel) runs for real.
//
// This adapter writes the same workspace files a real agent would, so the worker's
// captureBaseline/computeWorkspacePatch produces genuine patches and the
// fact-checker's `test ! -s outputs/findings` verify flips exactly as in a live run.
//
// Arc control (env PANGOLIN_FAKE_ARC):
//   'red'   (default) — first fact-check writes findings → done-but-red → respawn
//                       → fixer → re-gate (fact-check~2) writes none → green.
//   'green'           — fact-check writes no findings → announce runs, no circle-back.
//
// NOT a production adapter. Lives in the example; never shipped in the worker image.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type {
  RuntimeAdapter,
  RuntimeInvocation,
  RuntimeContext,
  RuntimeExit,
} from '@quarry-systems/pangolin-core';
import { EXECUTION_PATTERNS_TOPIC as TOPIC } from './config.js';

type Arc = 'red' | 'green';

/** Honest, unmistakably-fake usage so Row 4 passes ($0, model id prefixed `fake:`). */
function fakeUsage(model: string | undefined) {
  return { models: [`fake:${model ?? 'unset'}`], costUsd: 0, turns: 1 };
}

async function write(workspaceDir: string, rel: string, body: string): Promise<void> {
  const abs = join(workspaceDir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, body, 'utf8');
}

// Minimal but contract-shaped bodies (two-key frontmatter, ## headings) — enough to
// produce real, reviewable, cleanly-appliable patches. The PARTIAL page carries a
// deliberately wrong claim so a red gate is honest; the CORRECTED page fixes it.
const PARTIAL_PAGE =
  '---\ntitle: Execution Patterns\ndescription: How Pangolin runs queued work.\n---\n\n' +
  '## Patterns\n\nPangolin ships five patterns: map-reduce, pipeline, respawn, scan, ' +
  'and static-dag.\n\n## Pipeline\n\nPipeline runs all items fully in parallel. ' +
  '(FAKE-RUN partial draft — the claim above is wrong on purpose so the gate goes red.)\n';

const CORRECTED_PAGE =
  '---\ntitle: Execution Patterns\ndescription: How Pangolin runs queued work.\n---\n\n' +
  '## Patterns\n\nPangolin ships five patterns: map-reduce, pipeline, respawn, scan, ' +
  'and static-dag.\n\n## Pipeline\n\nPipeline runs items in dependency order with ' +
  'bounded concurrency — not unconditionally parallel. (FAKE-RUN corrected draft.)\n';

// Findings: a JSON array at outputs/findings (literal path — the provenance binding
// looks up outputRefs['findings']). Non-empty → `test ! -s outputs/findings` fails → red.
const FINDINGS_JSON = JSON.stringify(
  [
    {
      claim: 'Pipeline runs all items fully in parallel.',
      reality: 'pipeline.ts enforces dependency order with bounded concurrency.',
      evidence: 'packages/pangolin-orchestrator/src/patterns/pipeline.ts',
    },
  ],
  null,
  2,
);

/**
 * Build the scripted fake adapter. Stateful only in the fact-check counter, which
 * makes the FIRST gate evaluation red and every subsequent one green — exactly the
 * shape the respawn pattern expects (gate red → fix → re-gate green).
 */
export function createFakeRuntime(arc: Arc = 'red'): RuntimeAdapter {
  let factCheckCalls = 0;

  return {
    name: 'fake-scripted',
    reservedPaths: [],
    async invoke(spec: RuntimeInvocation, ctx: RuntimeContext): Promise<RuntimeExit> {
      const ws = spec.workspaceDir;
      // The real client assigns a UUID dispatchId, so we branch on the per-item
      // instructions (spec.input.instructions, verbatim from plan.json) instead —
      // each item's task text is distinct and stable.
      const input = spec.input as { instructions?: string } | undefined;
      const instr = typeof input?.instructions === 'string' ? input.instructions : '';
      let role = 'unknown';

      if (instr.includes('Fact-check EVERY claim')) {
        // fact-checker gate or re-gate. apply-work-patch has already git-applied the
        // page pre-adapter; we only decide findings. The counter makes the FIRST
        // evaluation red and the re-gate green (the respawn convergence).
        role = 'fact-checker';
        factCheckCalls += 1;
        if (arc === 'red' && factCheckCalls === 1) {
          await write(ws, 'outputs/findings', FINDINGS_JSON);
        }
        // green: write nothing → `test ! -s outputs/findings` passes.
      } else if (instr.includes('Reconstruct the page from the patch')) {
        // page-fixer: writes the corrected page (no apply-work-patch capability).
        role = 'page-fixer';
        await write(ws, TOPIC.pagePath, CORRECTED_PAGE);
      } else if (instr.includes('Create the execution-patterns explanation page')) {
        role = 'page-writer';
        await write(ws, TOPIC.pagePath, PARTIAL_PAGE);
      } else if (instr.includes('Add ONE entry to CHANGELOG')) {
        // announcer: apply-work-patch applied the page; append a CHANGELOG entry.
        role = 'announcer';
        await write(
          ws,
          'CHANGELOG.md',
          '\n## [Unreleased]\n### Added\n- **Execution Patterns** — new explanation page ' +
            '(docs/superpowers/specs/2026-06-06-dogfood-run3-gated-circleback-design.md). (FAKE-RUN)\n',
        );
      }
      // Unknown role → no-op (empty patch). Still seals fake usage.

      return {
        exitCode: 0,
        stdout: `fake-runtime[${role}]: ${ctx.dispatchId}`,
        stderr: '',
        usage: fakeUsage(spec.model),
      };
    },
  };
}
