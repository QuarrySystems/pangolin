// pangolin.config.mjs — VERIFY-ONLY operator config for the dogfood-gated example.
//
// Purpose: let a process that never saw the run independently re-verify the
// persisted proof:
//
//   pnpm exec pangolin verify bundle.json --full
//
// The driver (src/index.ts) persists two text artifacts after sealing:
//   bundle.json          — the exported AuditBundle (the auditor artifact)
//   verify-context.json  — the signer PUBLIC key + the anchored root(s)
//
// This config supplies the `orch` export `pangolin verify` needs: a read-only
// anchor that serves the persisted anchored roots, and a verifySignature bound
// to the persisted public key. No store, no Docker, no network, no secrets —
// the five check rows (chain / root / signature / anchor / handoff) are
// recomputed from the two files alone. That is the wedge demo: the proof is
// independently checkable by anyone holding the artifacts.
//
// IMPORT-SAFE: reads happen lazily inside the anchor/verify calls, so loading
// this config before a run has ever produced the artifacts does not throw.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEd25519 } from '@quarry-systems/pangolin-orchestrator';

const here = dirname(fileURLToPath(import.meta.url));
const CTX_PATH = join(here, 'verify-context.json');

const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const loadCtx = () => JSON.parse(readFileSync(CTX_PATH, 'utf8'));

/** Read-only AuditAnchor serving the persisted anchored roots (LocalAnchor tier). */
const anchor = {
  id: 'local',
  guarantee: 'detect',
  async anchor() {
    throw new Error('dogfood-gated verify config: read-only anchor (run the driver to anchor)');
  },
  async fetch({ epochId } = {}) {
    let ctx;
    try {
      ctx = loadCtx();
    } catch {
      return []; // no run persisted yet — verify reports the anchor row honestly missing
    }
    return ctx.anchoredRoots
      .filter((a) => !epochId || a.epochId === epochId)
      .map((a) => ({
        epochId: a.epochId,
        root: b64(a.root),
        ...(a.signature ? { signature: { ...a.signature, bytes: b64(a.signature.bytes) } } : {}),
        receipt: a.receipt,
      }));
  },
};

/** Ed25519 check against the PERSISTED public key (not a fresh keypair). */
const verifySignature = (root, sig) => {
  try {
    return verifyEd25519(root, sig, b64(loadCtx().publicKey));
  } catch {
    return false;
  }
};

export const orch = { anchor, verifySignature };
