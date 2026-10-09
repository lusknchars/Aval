/**
 * What a transaction ACTUALLY did, read from the block.
 *
 * Re-simulating a transaction that already landed usually fails: an arbitrage
 * that was profitable at its own slot is not any more, and a failed simulation
 * has no post-state, so the effect list comes back empty. For the live demo
 * that is a wall -- most of what the chain is doing right now shows as
 * "cannot know".
 *
 * But the chain recorded the answer. `getTransaction` returns the balances
 * before and after, which is the same diff the normalizer computes, already
 * taken by the validator.
 *
 * THIS NEVER FEEDS A VERDICT. AVAL judges before signing, where history does
 * not exist yet; using it to decide would be answering a different question
 * and calling it the same one. It is here so a demo can show what a real
 * transaction did, labelled as history rather than as a prediction.
 */
import { z } from "zod";
import { rpcCall } from "../cli/blocks.js";
import { formatRawAmount } from "../normalization/spl.js";

const tokenBalanceSchema = z.object({
  accountIndex: z.number(),
  mint: z.string(),
  owner: z.string().optional(),
  uiTokenAmount: z.object({
    amount: z.string(),
    decimals: z.number(),
  }),
});

const replySchema = z.object({
  result: z
    .object({
      slot: z.number(),
      blockTime: z.number().nullable().optional(),
      transaction: z.object({
        message: z.object({
          accountKeys: z.array(
            z.union([z.string(), z.object({ pubkey: z.string() })]),
          ),
        }),
      }),
      meta: z
        .object({
          err: z.unknown().nullable(),
          fee: z.number(),
          preBalances: z.array(z.number()),
          postBalances: z.array(z.number()),
          preTokenBalances: z.array(tokenBalanceSchema).nullable().optional(),
          postTokenBalances: z.array(tokenBalanceSchema).nullable().optional(),
          loadedAddresses: z
            .object({
              writable: z.array(z.string()),
              readonly: z.array(z.string()),
            })
            .optional(),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
});

export interface HistoricalEffects {
  readonly slot: number;
  readonly blockTime: number | null;
  readonly succeeded: boolean;
  readonly lines: readonly string[];
}

function short(address: string): string {
  return address.length > 14
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : address;
}

/** The account list, in the order the balance arrays are indexed by. */
function accountsOf(
  keys: readonly (string | { pubkey: string })[],
  loaded: { writable: readonly string[]; readonly: readonly string[] } | undefined,
): readonly string[] {
  const statics = keys.map((k) => (typeof k === "string" ? k : k.pubkey));
  return loaded === undefined
    ? statics
    : [...statics, ...loaded.writable, ...loaded.readonly];
}

export async function historicalEffects(
  url: string,
  signature: string,
): Promise<HistoricalEffects | null> {
  const payload = await rpcCall(url, "getTransaction", [
    signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 },
  ]);
  if (payload === null) return null;
  const parsed = replySchema.safeParse(payload);
  if (!parsed.success) return null;
  const result = parsed.data.result;
  if (result === null || result === undefined || result.meta === null) return null;
  const meta = result.meta;

  const accounts = accountsOf(
    result.transaction.message.accountKeys,
    meta.loadedAddresses,
  );
  const lines: string[] = [];

  // Native balances. The fee payer's first entry includes the fee, which is
  // named rather than folded in -- the same rule the normalizer follows.
  meta.preBalances.forEach((before, i) => {
    const after = meta.postBalances[i];
    const address = accounts[i];
    if (after === undefined || address === undefined) return;
    let delta = BigInt(after) - BigInt(before);
    if (i === 0) delta += BigInt(meta.fee);
    if (delta === 0n) return;
    lines.push(
      delta > 0n
        ? `entram ${formatRawAmount(delta, 9)} SOL em ${short(address)}`
        : `saem ${formatRawAmount(-delta, 9)} SOL de ${short(address)}`,
    );
  });

  // Token balances, matched by account index.
  const before = new Map(
    (meta.preTokenBalances ?? []).map((b) => [b.accountIndex, b]),
  );
  for (const after of meta.postTokenBalances ?? []) {
    const start = before.get(after.accountIndex);
    const from = start === undefined ? 0n : BigInt(start.uiTokenAmount.amount);
    const delta = BigInt(after.uiTokenAmount.amount) - from;
    if (delta === 0n) continue;
    const who = after.owner === undefined ? "" : `, de ${short(after.owner)}`;
    const size = formatRawAmount(
      delta > 0n ? delta : -delta,
      after.uiTokenAmount.decimals,
    );
    lines.push(
      delta > 0n
        ? `entram ${size} ${short(after.mint)}${who}`
        : `saem ${size} ${short(after.mint)}${who}`,
    );
  }

  if (meta.fee > 0)
    lines.push(`taxa paga: ${formatRawAmount(BigInt(meta.fee), 9)} SOL`);

  return {
    slot: result.slot,
    blockTime: result.blockTime ?? null,
    succeeded: meta.err === null,
    lines,
  };
}
