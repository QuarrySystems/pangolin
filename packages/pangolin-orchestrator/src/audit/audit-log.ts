import type { AuditStore, AuditEntry, Signer, AuditAnchor, AnchorReceipt } from '../contracts/index.js';
import { canonEntry } from './canon.js';
import { chainHash, merkleRoot, leavesFromEntryHashes } from './merkle.js';

export class AuditLog {
  constructor(private readonly deps: { store: AuditStore; signer: Signer; anchor: AuditAnchor }) {}

  /** Assign per-run seq, chain off the current head, persist. */
  append(entry: Omit<AuditEntry, 'seq'>): void {
    const seq = this.deps.store.getAuditEntries(entry.runId).length;
    const prevHash = this.deps.store.getAuditChainHead(entry.runId); // '' at genesis
    const full: AuditEntry = { ...entry, seq };
    const entryHash = chainHash(canonEntry(full), prevHash);
    this.deps.store.appendAuditEntry({ ...full, entryHash, prevHash });
  }

  /** epoch = run: Merkle over the run's entry hashes -> sign -> anchor -> persist. */
  async sealEpoch(runId: string): Promise<AnchorReceipt> {
    const hashes = this.deps.store.getAuditEntries(runId).map((e) => e.entryHash);
    const root = merkleRoot(leavesFromEntryHashes(hashes));
    const signature = await this.deps.signer.sign(root);
    const receipt = await this.deps.anchor.anchor({ epochId: runId, root, signature });
    this.deps.store.putAuditRoot({ epochId: runId, root, signature, receipt }); // durable seal marker
    return receipt;
  }
}
