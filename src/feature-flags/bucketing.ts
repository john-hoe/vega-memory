import { createHash } from "node:crypto";

/**
 * Deterministic traffic bucketing using sha256.
 * Returns an integer 0-99 for the given seed and flag_id.
 * Same seed + flag_id → same bucket forever.
 */
export function hashBucket(seed: string, flagId: string): number {
  const hash = createHash("sha256")
    .update(`${seed}:${flagId}`)
    .digest();
  // Take first 4 bytes as unsigned integer, modulo 100
  const value = hash.readUInt32BE(0);
  return value % 100;
}
