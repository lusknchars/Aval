/**
 * Runs the normalizer over real transactions taken from a recent block.
 *
 *   pnpm exec tsx --env-file=.env src/cli/sample-block.ts [--limit 20] [--delay 250]
 *
 * Nothing is signed and nothing is sent.
 *
 * Two things it is for: seeing the normalizer meet transactions nobody
 * designed for it, and measuring how often the answer is trustworthy.
 *
 * Re-simulating a historical transaction against today's state legitimately
 * fails a lot -- an arbitrage that was profitable at its own slot usually is
 * not any more. A failure here is information about the chain, not
 * necessarily about the normalizer.
 */
import { VersionedTransaction, type VersionedMessage } from "@solana/web3.js";
import { z } from "zod";
import { normalize } from "../normalization/normalize.js";
import {
  createRpcClient,
  readRpcConfig,
  type Network,
} from "../normalization/rpc.js";
import { coverageIsComplete, type EffectSet } from "../types/effects.js";

const VOTE_PROGRAM = "Vote111111111111111111111111111111111111111";

interface Args {
  readonly limit: number;
  readonly network: Network;
  readonly delayMs: number;
}

function parseArgs(argv: readonly string[]): Args | string {
  let limit = 20;
  let network: Network = "mainnet";
  let delayMs = 250;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 200)
        return "--limit takes 1..200";
      limit = value;
    } else if (arg === "--network") {
      const value = argv[++i];
      if (value !== "mainnet" && value !== "devnet")
        return "--network takes mainnet or devnet";
      network = value;
    } else if (arg === "--delay") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0 || value > 5000)
        return "--delay takes 0..5000 ms";
      delayMs = value;
    } else {
      return `unknown option: ${arg ?? ""}`;
    }
  }
  return { limit, network, delayMs };
}

/**
 * The block is fetched as raw base64 rather than through the SDK's decoder.
 *
 * A version 1 transaction can be read but not re-serialized, so rebuilding one
 * from a decoded message makes it impossible to simulate. Keeping the original
 * bytes sidesteps that -- and those bytes are exactly what an agent hands over
 * in production.
 */
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

async function rpcCall(
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return response.json();
}

function summarise(set: EffectSet): string {
  switch (set.simulation.status) {
    case "unavailable":
      return `unavailable   ${set.simulation.reason.slice(0, 58)}`;
    case "failed":
      return `would fail    ${set.simulation.error.slice(0, 58)}`;
    case "executed": {
      const counts = new Map<string, number>();
      for (const effect of set.effects)
        counts.set(effect.type, (counts.get(effect.type) ?? 0) + 1);
      const listed = [...counts].map(([type, n]) => `${type}x${n}`).join(" ");
      return `executed      ${listed === "" ? "no effects" : listed}`;
    }
  }
}

function isVote(message: VersionedMessage): boolean {
  return message.compiledInstructions.every(
    (ix) =>
      message.staticAccountKeys[ix.programIdIndex]?.toBase58() === VOTE_PROGRAM,
  );
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv);
  if (typeof args === "string") {
    console.error(args);
    return 1;
  }
  const config = readRpcConfig(process.env, args.network);
  if (!config.ok) {
    console.error(config.failure.message);
    return 1;
  }
  const rpc = createRpcClient(config.value);

  const slotReply = slotSchema.safeParse(
    await rpcCall(config.value.rpcUrl, "getSlot", [
      { commitment: "finalized" },
    ]),
  );
  if (!slotReply.success) {
    console.error("could not read the current slot");
    return 3;
  }
  const slot = slotReply.data.result - 40;

  const blockReply = blockSchema.safeParse(
    await rpcCall(config.value.rpcUrl, "getBlock", [
      slot,
      {
        encoding: "base64",
        transactionDetails: "full",
        rewards: false,
        commitment: config.value.commitment,
        maxSupportedTransactionVersion: 1,
      },
    ]),
  );
  if (
    !blockReply.success ||
    blockReply.data.error !== undefined ||
    blockReply.data.result === null
  ) {
    console.error(
      blockReply.success
        ? (blockReply.data.error?.message ?? "block unavailable")
        : "unexpected getBlock shape",
    );
    return 3;
  }

  // Deserialize for the message, keep the base64 for the simulation.
  const candidates: {
    base64: string;
    tx: VersionedTransaction;
    version: string;
  }[] = [];
  let votes = 0;
  let undecodable = 0;
  for (const entry of blockReply.data.result.transactions) {
    if (entry.meta?.err !== null) continue;
    const base64 = entry.transaction[0];
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
    } catch {
      undecodable++;
      continue;
    }
    if (isVote(tx.message)) {
      votes++;
      continue;
    }
    candidates.push({ base64, tx, version: String(tx.message.version) });
    if (candidates.length >= args.limit) break;
  }

  console.log(
    `block ${slot}: sampling ${candidates.length} transactions ` +
      `(${votes} votes skipped, ${undecodable} undecodable)\n`,
  );

  const tally = {
    executed: 0,
    failed: 0,
    unavailable: 0,
    aligned: 0,
    withLookups: 0,
    incomplete: 0,
    v1: 0,
    v1Executed: 0,
  };

  for (const [i, entry] of candidates.entries()) {
    // One alignment attempt only, plus a pause. Bulk sampling on a free tier
    // hits the rate limit long before anything else, and a 429 costs more
    // accuracy than a missed slot alignment.
    const set = await normalize(entry.tx, rpc, {
      alignmentAttempts: 1,
      rawTransactionBase64: entry.base64,
    });
    await new Promise((resolve) => setTimeout(resolve, args.delayMs));

    tally[set.simulation.status]++;
    const isV1 = entry.version === "1";
    if (isV1) tally.v1++;
    if (isV1 && set.simulation.status === "executed") tally.v1Executed++;
    if (entry.tx.message.addressTableLookups.length > 0) tally.withLookups++;
    if (set.slot !== null && set.slot === set.baselineSlot) tally.aligned++;
    if (!coverageIsComplete(set.coverage)) tally.incomplete++;

    const lookups = entry.tx.message.addressTableLookups.length;
    console.log(
      `${String(i + 1).padStart(3)}. v${entry.version.padEnd(6)} ` +
        `${String(set.coverage.referenced.length).padStart(3)} accts  ` +
        `${lookups > 0 ? `${String(lookups)} ALT` : "    "}  ` +
        `${set.slot === set.baselineSlot ? "    " : "GAP "}${summarise(set)}`,
    );
  }

  console.log(
    `\nexecuted ${tally.executed} · would fail ${tally.failed} · unavailable ${tally.unavailable}` +
      `\nversion 1: ${tally.v1} sampled, ${tally.v1Executed} simulated successfully` +
      `\nslot-aligned ${tally.aligned}/${candidates.length} · used lookup tables ${tally.withLookups}` +
      `\nincomplete coverage ${tally.incomplete} (expected: readonly accounts are never observed)`,
  );
  return 0;
}

process.exitCode = await main();
