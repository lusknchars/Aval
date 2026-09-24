/**
 * Runs the normalizer over real transactions taken from a recent block.
 *
 *   pnpm exec tsx --env-file=.env src/cli/sample-block.ts [--limit 20] [--network mainnet]
 *
 * Takes confirmed transactions, rebuilds each one UNSIGNED from its message,
 * and normalises it. Nothing is signed and nothing is sent.
 *
 * Two things it is for: seeing the normalizer meet transactions nobody
 * designed for it, and measuring how often the answer is trustworthy.
 *
 * Re-simulating a historical transaction against today's state legitimately
 * fails a lot -- a swap that was profitable at its own slot usually is not
 * any more. A failure here is information about the state of the chain, not
 * necessarily about the normalizer.
 */
import {
  Connection,
  VersionedTransaction,
  type VersionedMessage,
} from "@solana/web3.js";
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

function summarise(set: EffectSet): string {
  switch (set.simulation.status) {
    case "unavailable":
      return `unavailable   ${set.simulation.reason.slice(0, 60)}`;
    case "failed":
      return `would fail    ${set.simulation.error.slice(0, 60)}`;
    case "executed": {
      const counts = new Map<string, number>();
      for (const effect of set.effects)
        counts.set(effect.type, (counts.get(effect.type) ?? 0) + 1);
      const listed = [...counts].map(([type, n]) => `${type}x${n}`).join(" ");
      return `executed      ${listed === "" ? "no effects" : listed}`;
    }
  }
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
  const connection = new Connection(config.value.rpcUrl, {
    commitment: config.value.commitment,
  });

  const slot = (await connection.getSlot("finalized")) - 40;
  const block = await connection.getBlock(slot, {
    transactionDetails: "full",
    rewards: false,
    maxSupportedTransactionVersion: 1,
  });
  if (block === null) {
    console.error(`block ${slot} is not available`);
    return 3;
  }

  // Most of a mainnet block is validators voting, and re-simulating an old
  // vote always fails because it has already been processed. Those say
  // nothing about agent activity, so they are left out.
  const isVote = (message: VersionedMessage): boolean =>
    message.compiledInstructions.every(
      (ix) =>
        message.staticAccountKeys[ix.programIdIndex]?.toBase58() ===
        VOTE_PROGRAM,
    );

  const candidates = block.transactions
    .filter(
      (entry) => entry.meta?.err === null && !isVote(entry.transaction.message),
    )
    .slice(0, args.limit);
  const votes =
    block.transactions.length -
    block.transactions.filter((e) => !isVote(e.transaction.message)).length;
  console.log(
    `block ${slot}: ${block.transactions.length} transactions (${votes} votes skipped), sampling ${candidates.length}\n`,
  );

  const tally = {
    executed: 0,
    failed: 0,
    unavailable: 0,
    aligned: 0,
    withLookups: 0,
    incomplete: 0,
    rateLimited: 0,
    unsupportedVersion: 0,
  };

  for (const [i, entry] of candidates.entries()) {
    const message: VersionedMessage = entry.transaction.message;
    // One alignment attempt only, plus a pause between transactions. Bulk
    // sampling on a free RPC tier hits the rate limit long before anything
    // else, and a 429 costs more accuracy than a missed slot alignment.
    const set = await normalize(new VersionedTransaction(message), rpc, {
      alignmentAttempts: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, args.delayMs));

    tally[set.simulation.status]++;
    if (set.simulation.status === "unavailable") {
      if (set.simulation.reason.includes("429")) tally.rateLimited++;
      if (set.simulation.reason.includes("version 1"))
        tally.unsupportedVersion++;
    }
    if (message.addressTableLookups.length > 0) tally.withLookups++;
    if (set.slot !== null && set.slot === set.baselineSlot) tally.aligned++;
    if (!coverageIsComplete(set.coverage)) tally.incomplete++;

    const signature = entry.transaction.signatures[0] ?? "";
    const lookups = message.addressTableLookups.length;
    console.log(
      `${String(i + 1).padStart(3)}. ${signature.slice(0, 8)}…  ` +
        `${String(set.coverage.referenced.length).padStart(3)} accts  ` +
        `${lookups > 0 ? `${lookups} ALT` : "    "}  ` +
        `${set.slot === set.baselineSlot ? "    " : "GAP "}${summarise(set)}`,
    );
  }

  console.log(
    `\nexecuted ${tally.executed} · would fail ${tally.failed} · unavailable ${tally.unavailable}` +
      ` (rate limited ${tally.rateLimited}, unsupported v1 ${tally.unsupportedVersion})` +
      `\nslot-aligned ${tally.aligned}/${candidates.length} · used lookup tables ${tally.withLookups}` +
      `\nincomplete coverage ${tally.incomplete} (expected: readonly accounts are never observed)`,
  );
  return 0;
}

process.exitCode = await main();
