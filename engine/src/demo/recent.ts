/**
 * A window onto what is actually landing on mainnet right now.
 *
 * Deliberately CHEAP: everything here comes out of the block itself, with no
 * simulation and no account reads. Listing twenty transactions must not cost
 * twenty pipelines -- the pipeline runs when somebody picks one.
 *
 * The program names exist so the list is readable. Anything not in the table
 * is shown as its address rather than guessed at: a wrong label on a program
 * is worse than no label, because the whole point of the list is deciding
 * which transaction is worth looking at.
 */
import bs58 from "bs58";
import type { VersionedTransaction } from "@solana/web3.js";
import { transactionsInBlock, recentSlot } from "../cli/blocks.js";
import type { Network } from "../normalization/rpc.js";

export const PROGRAM_NAMES: ReadonlyMap<string, string> = new Map([
  ["11111111111111111111111111111111", "System"],
  ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "Token"],
  ["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "Token-2022"],
  ["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "Associated Token"],
  ["ComputeBudget111111111111111111111111111111", "Compute Budget"],
  ["Stake11111111111111111111111111111111111111", "Stake"],
  ["Vote111111111111111111111111111111111111111", "Vote"],
  ["BPFLoaderUpgradeab1e11111111111111111111111", "Upgradeable Loader"],
  ["AddressLookupTab1e1111111111111111111111111", "Address Lookup Table"],
  ["Ed25519SigVerify111111111111111111111111111", "Ed25519 verify"],
  ["KeccakSecp256k11111111111111111111111111111", "Secp256k1 verify"],
  ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "Jupiter v6"],
  ["JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB", "Jupiter v4"],
  ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "Raydium AMM v4"],
  ["CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", "Raydium CLMM"],
  ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "Orca Whirlpool"],
  ["LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", "Meteora DLMM"],
  ["MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA", "Marginfi v2"],
  ["dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH", "Drift v2"],
  ["metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", "Token Metadata"],
  ["cndy3Z4yapfJBmL3ShUp5exZKqR3z33thTzeNMm2gRZ", "Candy Machine"],
  ["Stake11111111111111111111111111111111111111", "Stake"],
]);

export interface RecentTransaction {
  readonly signature: string;
  readonly version: string;
  readonly instructions: number;
  readonly accounts: number;
  readonly lookupTables: number;
  readonly fee: string | null;
  /** Top-level programs, named where the name is known. */
  readonly programs: readonly string[];
}

function programsOf(tx: VersionedTransaction): readonly string[] {
  const seen = new Set<string>();
  for (const instruction of tx.message.compiledInstructions) {
    const key = tx.message.staticAccountKeys[instruction.programIdIndex];
    if (key === undefined) {
      // The program came from a lookup table, which costs a round trip to
      // resolve. Not worth it to render a list.
      seen.add("(via lookup table)");
      continue;
    }
    const address = key.toBase58();
    seen.add(PROGRAM_NAMES.get(address) ?? `${address.slice(0, 8)}…`);
  }
  return [...seen];
}

/** Recent successful, non-vote transactions, with nothing simulated. */
export async function recentTransactions(
  url: string,
  commitment: string,
  limit: number,
): Promise<{ slot: number; transactions: readonly RecentTransaction[] } | string> {
  const slot = await recentSlot(url);
  if (slot === null) return "could not read the current slot";
  const sampled = await transactionsInBlock(url, slot, limit, commitment);
  if (sampled.length === 0) return `block ${slot} returned nothing`;

  const transactions = sampled.map((entry) => ({
    signature: bs58.encode(entry.tx.signatures[0] ?? new Uint8Array(64)),
    version: entry.version,
    instructions: entry.tx.message.compiledInstructions.length,
    accounts: entry.tx.message.staticAccountKeys.length,
    lookupTables: entry.tx.message.addressTableLookups.length,
    fee: entry.actualFee === null ? null : entry.actualFee.toString(),
    programs: programsOf(entry.tx),
  }));
  return { slot, transactions };
}

export type { Network };
