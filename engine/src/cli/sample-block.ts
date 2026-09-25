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
import { counterparties, effectShapeProblems } from "../types/effects.js";
import { resolveAccounts } from "../normalization/accounts.js";
import { declaredFeeOf } from "../normalization/fee.js";
import { normalize } from "../normalization/normalize.js";
import {
  createRpcClient,
  readRpcConfig,
  type Network,
} from "../normalization/rpc.js";
import { recentSlot, transactionsInBlock } from "./blocks.js";

interface Args {
  readonly limit: number;
  readonly network: Network;
  readonly delayMs: number;
  readonly blocks: number;
}

function parseArgs(argv: readonly string[]): Args | string {
  let limit = 20;
  let network: Network = "mainnet";
  let delayMs = 250;
  let blocks = 1;
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
    } else if (arg === "--blocks") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 20)
        return "--blocks takes 1..20";
      blocks = value;
    } else if (arg === "--delay") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0 || value > 5000)
        return "--delay takes 0..5000 ms";
      delayMs = value;
    } else {
      return `unknown option: ${arg ?? ""}`;
    }
  }
  return { limit, network, delayMs, blocks };
}

/**
 * The effects VETO exists to catch. Counting how often they show up in traffic
 * nobody designed for us is the point of sampling at all: a detector that
 * never fires on real data is untested, and one that fires constantly is
 * useless.
 */
const NOTABLE = new Set([
  "DELEGATE_GRANT",
  "OWNER_CHANGE",
  "AUTHORITY_CHANGE",
  "ACCOUNT_CLOSE",
  "ACCOUNT_FREEZE",
]);

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
  const url = config.value.rpcUrl;

  const firstSlot = await recentSlot(url);
  if (firstSlot === null) {
    console.error("could not read the current slot");
    return 3;
  }

  const tally = {
    executed: 0,
    failed: 0,
    unavailable: 0,
    aligned: 0,
    withLookups: 0,
    v1: 0,
    sampled: 0,
  };
  const effectCounts = new Map<string, number>();
  /**
   * Every effect from real traffic, against the shape contract for its type.
   *
   * The contract is worth nothing if it is only checked against the cases
   * somebody remembered to write down. This is where it earns its keep: the
   * same function the tests use, applied to transactions nobody designed for
   * it.
   */
  const shapeViolations: string[] = [];
  /**
   * The fee read out of the bytes, against the fee the network actually
   * charged. The parser exists because `getFeeForMessage` needs a live
   * blockhash and therefore prices no historical transaction, and the fee is
   * the one amount no manifest bounds -- so it has to be right.
   */
  const feeCheck = { compared: 0, agreed: 0, unknown: 0, wrong: [] as string[] };
  const notable: string[] = [];
  /**
   * How many addresses the provenance check would have to explain per
   * transaction. This is the false-positive surface: every counterparty a
   * legitimate flow produces is an address the customer's captured context
   * has to account for, or the check fires on honest work.
   */
  const counterpartyCounts: number[] = [];

  for (let b = 0; b < args.blocks; b++) {
    const slot = firstSlot - b * 2;
    const candidates = await transactionsInBlock(
      url,
      slot,
      args.limit,
      config.value.commitment,
    );
    console.log(`block ${slot}: ${candidates.length} transactions`);

    for (const entry of candidates) {
      // One alignment attempt only, plus a pause. Bulk sampling on a free tier
      // hits the rate limit long before anything else, and a 429 costs more
      // accuracy than a missed slot alignment.
      const set = await normalize(entry.tx, rpc, {
        alignmentAttempts: 1,
        rawTransactionBase64: entry.base64,
      });
      await new Promise((resolve) => setTimeout(resolve, args.delayMs));

      // Pure, no network: the accounts are already resolved for the diff.
      const resolvedForFee = await resolveAccounts(entry.tx.message, rpc);
      if (resolvedForFee.ok && entry.actualFee !== null) {
        const declared = declaredFeeOf(
          entry.tx.message,
          resolvedForFee.value.accounts,
        ).total;
        if (declared === null) {
          feeCheck.unknown++;
        } else {
          feeCheck.compared++;
          if (declared === entry.actualFee) feeCheck.agreed++;
          else
            feeCheck.wrong.push(
              `slot ${slot}: declared ${declared}, charged ${entry.actualFee}`,
            );
        }
      }

      tally.sampled++;
      tally[set.simulation.status]++;
      if (entry.version === "1") tally.v1++;
      if (entry.tx.message.addressTableLookups.length > 0) tally.withLookups++;
      if (set.slot !== null && set.slot === set.baselineSlot) tally.aligned++;

      if (set.simulation.status === "executed") {
        counterpartyCounts.push(counterparties(set).length);
      }

      for (const effect of set.effects) {
        effectCounts.set(effect.type, (effectCounts.get(effect.type) ?? 0) + 1);
        const problems = effectShapeProblems(effect);
        if (problems.length > 0)
          shapeViolations.push(
            `slot ${slot} ${effect.type}: ${problems.join(", ")}`,
          );
        if (NOTABLE.has(effect.type)) {
          const unlimited =
            effect.type === "DELEGATE_GRANT" &&
            effect.amount !== undefined &&
            effect.amount >= 18_446_744_073_709_551_615n;
          notable.push(
            `slot ${slot}  ${effect.type}  account ${effect.account.slice(0, 8)}…` +
              `${effect.counterparty === undefined ? "" : ` -> ${effect.counterparty.slice(0, 8)}…`}` +
              `${unlimited ? "  UNLIMITED ALLOWANCE" : ""}`,
          );
        }
      }
    }
  }

  const rate = (n: number): string =>
    `${((n / Math.max(1, tally.sampled)) * 100).toFixed(0)}%`;
  console.log(
    `\n${tally.sampled} transactions across ${args.blocks} block(s)` +
      `\n  executed ${tally.executed} (${rate(tally.executed)}) · would fail ${tally.failed} · unavailable ${tally.unavailable}` +
      `\n  version 1 ${tally.v1} · used lookup tables ${tally.withLookups} · slot-aligned ${tally.aligned}`,
  );

  if (feeCheck.compared + feeCheck.unknown > 0) {
    console.log(
      `\nfee read from the bytes, against what the network charged` +
        `\n  agreed ${feeCheck.agreed} of ${feeCheck.compared}` +
        `\n  not computable (price set with no limit): ${feeCheck.unknown}`,
    );
    for (const line of feeCheck.wrong.slice(0, 8)) console.log(`  ${line}`);
  }

  const totalEffects = [...effectCounts.values()].reduce((a, b) => a + b, 0);
  console.log(
    `\nshape contract: ${totalEffects - shapeViolations.length} of ${totalEffects} effects conform`,
  );
  for (const line of shapeViolations.slice(0, 10)) console.log(`  ${line}`);

  console.log("\neffects observed:");
  if (effectCounts.size === 0) console.log("  none");
  for (const [type, n] of [...effectCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(18)} ${n}`);
  }

  if (counterpartyCounts.length > 0) {
    const sorted = [...counterpartyCounts].sort((a, b) => a - b);
    const at = (fraction: number): number =>
      sorted[
        Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
      ] ?? 0;
    const none = sorted.filter((n) => n === 0).length;
    console.log(
      `\ncounterparties per executed transaction` +
        `\n  median ${at(0.5)} · p90 ${at(0.9)} · max ${sorted[sorted.length - 1] ?? 0}` +
        `\n  with none at all: ${none} of ${sorted.length}`,
    );
  }

  console.log(`\nsecurity-relevant effects: ${notable.length}`);
  for (const line of notable.slice(0, 20)) console.log(`  ${line}`);
  if (notable.length > 20) console.log(`  ... ${notable.length - 20} more`);

  return 0;
}

process.exitCode = await main();
