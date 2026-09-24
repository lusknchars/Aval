/**
 * Pulling real transactions out of recent blocks.
 *
 * Shared by the sampling CLIs. The block is fetched as raw base64 rather than
 * through the SDK's decoder: a version 1 transaction can be read but not
 * re-serialized, so rebuilding one from a decoded message makes it impossible
 * to simulate. Keeping the original bytes sidesteps that -- and those bytes
 * are exactly what an agent hands over in production.
 */
import { VersionedTransaction, type VersionedMessage } from "@solana/web3.js";
import { z } from "zod";

const VOTE_PROGRAM = "Vote111111111111111111111111111111111111111";

const blockSchema = z.object({
  result: z
    .object({
      transactions: z.array(
        z.object({
          transaction: z.tuple([z.string(), z.literal("base64")]),
          meta: z.object({ err: z.unknown().nullable() }).nullable(),
        }),
      ),
    })
    .nullable(),
  error: z.object({ message: z.string() }).optional(),
});

const slotSchema = z.object({ result: z.number() });

/**
 * One JSON-RPC call, or null.
 *
 * null rather than a throw, and the check on `response.ok` rather than
 * straight to `.json()`, because a rate limit does not answer in JSON: it
 * answers `Too Many Requests` in plain text, and parsing that threw an
 * unhandled rejection that took the whole run down mid-sample. Sampling is
 * exactly the workload that hits a rate limit, so it is the one place that
 * has to survive one.
 *
 * A 429 is retried once after a pause, because it usually means "slow down",
 * not "no".
 */
export async function rpcCall(
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (response.status === 429 && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      if (!response.ok) {
        console.error(`  ${method}: ${response.status} ${response.statusText}`);
        return null;
      }
      return await response.json();
    } catch (error) {
      console.error(
        `  ${method}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
  return null;
}

export interface SampledTransaction {
  readonly slot: number;
  readonly base64: string;
  readonly tx: VersionedTransaction;
  readonly version: string;
}

function isVote(message: VersionedMessage): boolean {
  return message.compiledInstructions.every(
    (ix) =>
      message.staticAccountKeys[ix.programIdIndex]?.toBase58() === VOTE_PROGRAM,
  );
}

/** The most recent finalized slot, minus a margin so the block is available. */
export async function recentSlot(url: string): Promise<number | null> {
  const payload = await rpcCall(url, "getSlot", [{ commitment: "finalized" }]);
  if (payload === null) return null;
  const reply = slotSchema.safeParse(payload);
  return reply.success ? reply.data.result - 40 : null;
}

/** Succeeded, non-vote transactions from one block. */
export async function transactionsInBlock(
  url: string,
  slot: number,
  limit: number,
  commitment: string,
): Promise<readonly SampledTransaction[]> {
  const payload = await rpcCall(url, "getBlock", [
    slot,
    {
      encoding: "base64",
      transactionDetails: "full",
      rewards: false,
      commitment,
      maxSupportedTransactionVersion: 1,
    },
  ]);
  if (payload === null) return [];
  const reply = blockSchema.safeParse(payload);
  if (
    !reply.success ||
    reply.data.error !== undefined ||
    reply.data.result === null
  )
    return [];

  const sampled: SampledTransaction[] = [];
  for (const entry of reply.data.result.transactions) {
    if (entry.meta?.err !== null) continue;
    const base64 = entry.transaction[0];
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
    } catch {
      continue;
    }
    if (isVote(tx.message)) continue;
    sampled.push({ slot, base64, tx, version: String(tx.message.version) });
    if (sampled.length >= limit) break;
  }
  return sampled;
}
