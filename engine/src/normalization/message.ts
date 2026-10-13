/**
 * The bytes a wallet actually signs.
 *
 * Two things need them and neither can get them from the SDK alone: the
 * digest that ties a verdict to one specific transaction, and
 * `getFeeForMessage`, which takes a serialized message.
 *
 * `@solana/web3.js` 1.x reads a version 1 message and refuses to serialize
 * one, so for v1 the message is taken straight out of the original wire bytes
 * by stepping over the signature section. Same trick as the simulation: the
 * SDK's serializer is what is missing, not the data.
 */
import { createHash } from "node:crypto";
import type { VersionedTransaction } from "@solana/web3.js";

/** Length of a compact-u16, the shortvec the wire format counts with. */
export function shortvecLength(n: number): number {
  return n < 0x80 ? 1 : n < 0x4000 ? 2 : 3;
}

/**
 * The signable message, or null when it cannot be obtained.
 *
 * `raw` is the transaction's original base64, needed only for v1.
 */
export function messageBytes(
  tx: VersionedTransaction,
  raw: string | undefined,
): Buffer | null {
  try {
    return Buffer.from(tx.message.serialize());
  } catch {
    // A version 1 message. Fall through to the original bytes.
  }
  if (raw === undefined) return null;
  const all = Buffer.from(raw, "base64");
  // The signature section: a compact-u16 count, then 64 bytes each. The count
  // is trustworthy because the transaction deserialized.
  const offset = shortvecLength(tx.signatures.length) + 64 * tx.signatures.length;
  return offset < all.length ? all.subarray(offset) : null;
}

/**
 * sha256 of the signable message, hex.
 *
 * The MESSAGE, never the transaction: signatures are part of a serialized
 * transaction, so hashing the whole thing gives a value that changes at the
 * moment of signing -- exactly useless for binding a verdict to bytes.
 */
export function messageDigestOf(
  tx: VersionedTransaction,
  raw: string | undefined,
): string | null {
  const bytes = messageBytes(tx, raw);
  return bytes === null
    ? null
    : createHash("sha256").update(bytes).digest("hex");
}
