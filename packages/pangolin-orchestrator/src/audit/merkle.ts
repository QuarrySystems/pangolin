import { createHash } from 'node:crypto';

const sha = (b: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(b).digest());

const pair = (a: Uint8Array, b: Uint8Array): Uint8Array =>
  sha(Buffer.concat([Buffer.from([0x01]), a, b]));

/** Deterministic Merkle root over leaves.
 * Empty → 32 zero bytes.
 * Leaf domain: SHA256(0x00 ‖ leaf).
 * Internal domain: SHA256(0x01 ‖ L ‖ R).
 * Odd node at end of a level is CARRIED UP UNHASHED (not duplicated).
 * Byte-identical to Mneme src/audit/merkle.ts.
 */
export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return new Uint8Array(32);
  let level: Uint8Array[] = leaves.map((l) => sha(Buffer.concat([Buffer.from([0x00]), l])));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(i + 1 < level.length ? pair(level[i]!, level[i + 1]!) : level[i]!);
    level = next;
  }
  return level[0]!;
}

/** Decode entry hash hex strings to raw 32-byte Uint8Arrays for use as merkle leaves. */
export function leavesFromEntryHashes(hexes: string[]): Uint8Array[] {
  return hexes.map((h) => Uint8Array.from(Buffer.from(h, 'hex')));
}

/** Chain hash: sha256(canonStr + prevHash) → hex. Genesis prev is ''.
 * Byte-identical to Mneme audit-log.ts chain hash formula.
 */
export function chainHash(canonStr: string, prevHash: string): string {
  return createHash('sha256').update(canonStr + prevHash).digest('hex');
}
