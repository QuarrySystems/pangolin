// run-sealed.ts — the agent WITH the Pangolin seam.
//
// Diff this against run-plain.ts: the agent and the human decision are
// identical; the ONLY change is calling withProvenance() instead of runPlain()
// and writing the bundle it returns. That is the whole seam at the call site.
//
//   pnpm --filter langgraph-changeorder-example sealed
//
// Writes three auditor artifacts to ./out:
//   bundle.json          — the AuditBundle (chain + anchored Merkle root)
//   verify-context.json  — signer public key (SPKI-DER, b64) + offline anchor mode
//   approval.json        — the sealed human-approval record (its hash is in the chain)

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AnchoredRoot } from '@quarry-systems/pangolin-core';
import { withProvenance } from './seam.js';
import { SAMPLE_CHANGE_ORDER, type Decide } from './run-plain.js';

const b64 = (u8: Uint8Array): string => Buffer.from(u8).toString('base64');

/** Re-serialize an AnchoredRoot with binary fields base64-encoded for JSON
 *  transport. The verifier's buildAnchor() decodes these back to bytes. */
function encodeAnchoredRoot(root: AnchoredRoot | undefined): unknown {
  if (!root) return undefined;
  return {
    ...root,
    root: b64(root.root),
    signature: root.signature ? { ...root.signature, bytes: b64(root.signature.bytes) } : undefined,
    timestamp: root.timestamp ? { ...root.timestamp, token: b64(root.timestamp.token) } : undefined,
  };
}

export interface SealedArtifacts {
  bundleJson: unknown;
  contextJson: unknown;
  approvalJson: unknown;
}

/** Produce the three JSON artifacts from a provenance result. */
export async function sealChangeOrder(
  changeOrder = SAMPLE_CHANGE_ORDER,
  decide: Decide = fixedApproval,
): Promise<SealedArtifacts & { outcome: import('./agent.js').Outcome }> {
  const result = await withProvenance(changeOrder, decide);
  const bundleJson = {
    ...result.bundle,
    auditLog: { ...result.bundle.auditLog, root: encodeAnchoredRoot(result.bundle.auditLog.root) },
  };
  const contextJson = {
    signerPublicKeySpkiDer: result.signerPublicKeyB64,
    anchor: { mode: 'offline' as const },
  };
  return { bundleJson, contextJson, approvalJson: result.approvalRecord, outcome: result.outcome };
}

const fixedApproval: Decide = () => ({
  approver: 'human:dana.okafor (Project Director)',
  decision: 'approve',
  decidedAt: '2026-06-25T16:40:00.000Z',
  reason: 'Corrosion finding is material; substitution is the lowest-risk remedy.',
});

// Direct-invocation guard (ESM): true only when run as `tsx src/run-sealed.ts`.
const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const outDir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
  sealChangeOrder()
    .then(async ({ bundleJson, contextJson, approvalJson, outcome }) => {
      await mkdir(outDir, { recursive: true });
      const bundlePath = join(outDir, 'bundle.json');
      const contextPath = join(outDir, 'verify-context.json');
      const approvalPath = join(outDir, 'approval.json');
      await writeFile(bundlePath, JSON.stringify(bundleJson, null, 2));
      await writeFile(contextPath, JSON.stringify(contextJson, null, 2));
      await writeFile(approvalPath, JSON.stringify(approvalJson, null, 2));
      console.log(`agent ran WITH the Pangolin seam → ${outcome.outcome} (${outcome.changeOrderId})`);
      console.log(`  wrote ${bundlePath}`);
      console.log(`  wrote ${contextPath}`);
      console.log(`  wrote ${approvalPath}`);
      console.log(`\nnow verify (orchestrator-free):  pnpm --filter langgraph-changeorder-example verify`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
