// tamper.ts — a runnable demonstration that the verifier rejects tampering.
//
//   pnpm --filter langgraph-changeorder-example tamper
//
// Seals a run, verifies it (VERIFIED), then mutates ONE field two different ways
// and shows the verifier rejecting each. No assertions framework — just output a
// human can read. (The same checks run under vitest in test/proof.test.ts.)

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealChangeOrder } from './run-sealed.js';
import { verifyChangeOrder } from './verify.js';

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'co-tamper-demo-'));
  const { bundleJson, contextJson, approvalJson } = await sealChangeOrder();

  const contextPath = join(dir, 'verify-context.json');
  await writeFile(contextPath, JSON.stringify(contextJson, null, 2));

  // ── Baseline: the untampered bundle verifies. ──
  const cleanBundle = join(dir, 'bundle.json');
  const cleanApproval = join(dir, 'approval.json');
  await writeFile(cleanBundle, JSON.stringify(bundleJson, null, 2));
  await writeFile(cleanApproval, JSON.stringify(approvalJson, null, 2));
  const clean = await verifyChangeOrder({
    bundlePath: cleanBundle,
    contextPath,
    approvalPath: cleanApproval,
  });
  console.log(`baseline            : ${clean.ok ? 'VERIFIED ✓' : 'REJECTED ✗'} (intact=${clean.report.intact}, approval=${clean.approval.ok})`);

  // ── Tamper 1: rewrite one chain entry's timestamp. ──
  const t1 = structuredClone(bundleJson) as { auditLog: { entries: Array<{ at: string }> } };
  t1.auditLog.entries[2].at = '2030-01-01T00:00:00.000Z';
  const t1Bundle = join(dir, 'bundle.chain-tamper.json');
  await writeFile(t1Bundle, JSON.stringify(t1, null, 2));
  const r1 = await verifyChangeOrder({ bundlePath: t1Bundle, contextPath, approvalPath: cleanApproval });
  console.log(
    `tamper: chain field : ${r1.ok ? 'VERIFIED ✓' : 'REJECTED ✗'} (intact=${r1.report.intact}, failure=${r1.report.failure})`,
  );

  // ── Tamper 2: flip the sealed approval decision approve → reject. ──
  const t2 = structuredClone(approvalJson) as Record<string, unknown>;
  t2.decision = 'reject';
  const t2Approval = join(dir, 'approval.swap-decision.json');
  await writeFile(t2Approval, JSON.stringify(t2, null, 2));
  const r2 = await verifyChangeOrder({ bundlePath: cleanBundle, contextPath, approvalPath: t2Approval });
  console.log(
    `tamper: approval seal: ${r2.ok ? 'VERIFIED ✓' : 'REJECTED ✗'} (approval=${r2.approval.ok}) — ${r2.approval.detail}`,
  );

  const allRejected = clean.ok && !r1.ok && !r2.ok;
  console.log(`\n${allRejected ? 'PASS' : 'FAIL'}: clean verifies, both tampers rejected.`);
  process.exitCode = allRejected ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
