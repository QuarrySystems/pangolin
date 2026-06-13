import type {
  AuditStore,
  AuditEntry,
  Signer,
  AuditAnchor,
  AnchorReceipt,
  TimestampAuthority,
  TimestampToken,
} from '../contracts/index.js';
import { canonEntry } from './canon.js';
import { chainHash, merkleRoot, leavesFromEntryHashes } from './merkle.js';

export class AuditLog {
  private _droppedAppends = 0;

  constructor(
    private readonly deps: {
      store: AuditStore;
      signer: Signer;
      anchor: AuditAnchor;
      /** Optional trusted-time authority. When present, sealEpoch obtains an RFC-3161 token
       *  over the sealed root best-effort — a TSA outage must NEVER abort a seal. */
      timestamper?: TimestampAuthority;
      /** Called when tryAppend swallows a store failure — surface the drop to the operator. */
      onDrop?: (entry: Omit<AuditEntry, 'seq'>, err: Error) => void;
    },
  ) {}

  /** Count of append events dropped by tryAppend due to a store failure.
   *  >0 means the sealed record is INCOMPLETE — completeness is a SOC2 (CC7) /
   *  EU AI Act Art 12 requirement, so this must never go unnoticed. */
  get droppedAppends(): number {
    return this._droppedAppends;
  }

  /** Assign per-run seq, chain off the current head, persist. Throws on store failure. */
  append(entry: Omit<AuditEntry, 'seq'>): void {
    const seq = this.deps.store.getAuditEntries(entry.runId).length;
    const prevHash = this.deps.store.getAuditChainHead(entry.runId); // '' at genesis
    const full: AuditEntry = { ...entry, seq };
    const entryHash = chainHash(canonEntry(full), prevHash);
    this.deps.store.appendAuditEntry({ ...full, entryHash, prevHash });
  }

  /** Best-effort append: a failing store must NOT abort a tick or corrupt run state,
   *  but the drop is COUNTED (and surfaced via onDrop) rather than silently swallowed.
   *  Use this at every call site where audit is observability layered over the run. */
  tryAppend(entry: Omit<AuditEntry, 'seq'>): void {
    try {
      this.append(entry);
    } catch (err) {
      this._droppedAppends++;
      this.deps.onDrop?.(entry, err as Error);
    }
  }

  /** epoch = run: Merkle over the run's entry hashes -> sign -> anchor -> persist. */
  async sealEpoch(runId: string): Promise<AnchorReceipt> {
    const hashes = this.deps.store.getAuditEntries(runId).map((e) => e.entryHash);
    const root = merkleRoot(leavesFromEntryHashes(hashes));
    const signature = await this.deps.signer.sign(root);
    // Trusted-time: best-effort. A TSA outage must NOT abort the seal — drop is surfaced via onDrop.
    let timestamp: TimestampToken | undefined;
    if (this.deps.timestamper) {
      try {
        timestamp = await this.deps.timestamper.timestamp(root);
      } catch (err) {
        this.deps.onDrop?.({ runId, kind: 'run.completed', at: new Date(0).toISOString() }, err as Error);
      }
    }
    const receipt = await this.deps.anchor.anchor({ epochId: runId, root, signature });
    this.deps.store.putAuditRoot({ epochId: runId, root, signature, receipt, ...(timestamp ? { timestamp } : {}) }); // durable seal marker
    return receipt;
  }
}
