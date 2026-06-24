/** Parse a non-negative integer env value; throw on malformed (fail-fast). */
export function parsePositiveInteger(raw: string, varName: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`${varName} must be a non-negative integer, got: ${raw}`);
  }
  return n;
}
