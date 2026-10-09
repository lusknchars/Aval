/**
 * The false-positive measurement.
 *
 *   pnpm exec tsx --env-file=.env src/cli/sample-evaluate.ts [--blocks 12] [--limit 25] [--delay 400]
 *
 * Nothing is signed and nothing is sent.
 *
 * Real transactions carry no tool call, no user goal and no manifest, so they
 * cannot be evaluated as they stand. What this does instead is build the
 * declaration a TRUTHFUL agent would have made -- read off the transaction's
 * own effects -- and then evaluate the transaction against it, with a user
 * goal that names every counterparty.
 *
 * By construction nothing here is an attack. So every finding is a false
 * positive of the structural checks, and the tally at the end is the cost a
 * customer pays on honest work. A check that fires on honest work is a check
 * nobody will keep reading.
 *
 * It measures a LOWER BOUND, and deliberately: the declaration is derived
 * from the effects, so the checks are being given the friendliest possible
 * input. Anything that fires here fires on the easy case.
 */
import type { VersionedTransaction } from "@solana/web3.js";
import { counterparties, type EffectSet } from "../types/effects.js";
import { evaluate } from "../evaluation/verdict.js";
import { manifestFor, manifestVersions } from "../evaluation/manifests/index.js";
import { normalize } from "../normalization/normalize.js";
import {
  createRpcClient,
  readRpcConfig,
  type Network,
} from "../normalization/rpc.js";
import { DEFAULT_THRESHOLDS, type Verdict } from "../types/verdict.js";
import type { ActionContext } from "../types/context.js";
import { recentSlot, transactionsInBlock } from "./blocks.js";
import { declarationFor, decimalsFor, toDecimalArgs } from "./declaration.js";

interface Args {
  readonly limit: number;
  readonly network: Network;
  readonly delayMs: number;
  readonly blocks: number;
}

function parseArgs(argv: readonly string[]): Args | string {
  let limit = 20;
  let network: Network = "mainnet";
  let delayMs = 300;
  let blocks = 4;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 200)
        return "--limit takes 1..200";
      limit = value;
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
    } else if (arg === "--network") {
      const value = argv[++i];
      if (value !== "mainnet" && value !== "devnet")
        return "--network takes mainnet or devnet";
      network = value;
    } else {
      return `unknown option: ${arg ?? ""}`;
    }
  }
  return { limit, network, delayMs, blocks };
}

/**
 * A user goal that names every counterparty: the honest baseline.
 *
 * `silent` produces the same call with a goal that names nobody -- the shape
 * of an agent that picked the destination somewhere AVAL cannot see.
 */
function honestContext(
  set: EffectSet,
  tool: string,
  args: Record<string, unknown>,
  tx: VersionedTransaction,
  silent = false,
): ActionContext {
  const named = counterparties(set).join(", ");
  const goal = silent
    ? "do the thing we discussed"
    : `send funds to ${named === "" ? "myself" : named}`;
  return {
    actionId: `sample-${Date.now()}`,
    agentId: "sample",
    userGoal: goal,
    systemPrompt: "",
    contextChunks: [{ text: goal, provenance: "user" }],
    toolCall: { name: tool, args },
    unsignedTx: tx,
    timestamp: Date.now(),
  };
}

// ------------------------------------------------------------------- report

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function printCounts(title: string, counts: Map<string, number>): void {
  console.log(`\n${title}`);
  if (counts.size === 0) {
    console.log("  none");
    return;
  }
  for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${key}`);
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
  const url = config.value.rpcUrl;

  const firstSlot = await recentSlot(url);
  if (firstSlot === null) {
    console.error("could not read the current slot");
    return 3;
  }

  const decisions = new Map<string, number>();
  const rules = new Map<string, number>();
  const tools = new Map<string, number>();
  let executed = 0;
  let unclassified = 0;
  let tampered = 0;
  let understatable = 0;
  const caught = { understated: 0, silent: 0 };
  const caughtBy = new Map<string, number>();
  const examples: string[] = [];

  for (let b = 0; b < args.blocks; b++) {
    const slot = firstSlot - b * 2;
    const sampled = await transactionsInBlock(
      url,
      slot,
      args.limit,
      config.value.commitment,
    );
    console.log(`block ${slot}: ${sampled.length} transactions`);

    for (const entry of sampled) {
      const set = await normalize(entry.tx, rpc, {
        alignmentAttempts: 1,
        rawTransactionBase64: entry.base64,
      });
      await new Promise((resolve) => setTimeout(resolve, args.delayMs));
      if (set.simulation.status !== "executed") continue;
      executed++;

      const declaration = declarationFor(set);
      if (declaration === null) {
        unclassified++;
        bump(tools, "(no primitive matched)");
        continue;
      }
      bump(tools, declaration.tool);

      const decimals = await decimalsFor(declaration.mints, rpc);
      await new Promise((resolve) => setTimeout(resolve, args.delayMs));

      const run = (callArgs: Record<string, unknown>, silent: boolean): Verdict =>
        evaluate({
          effects: set,
          context: honestContext(
            set,
            declaration.tool,
            callArgs,
            entry.tx,
            silent,
          ),
          manifest: manifestFor(declaration.tool),
          decimals,
          provenance: {
            trustedSources: [],
            allowlist: [],
            knownCounterparties: [],
            // The payer is the agent's own wallet by definition here.
            ownAccounts: set.feePayer === null ? [] : [set.feePayer],
          },
          policy: {
            manifests: manifestVersions(),
            thresholds: DEFAULT_THRESHOLDS,
            sourcePatterns: [],
            allowlist: [],
          },
        });

      const verdict = run(toDecimalArgs(declaration, decimals), false);

      // The other side of the measurement. Same transaction, same manifest,
      // and a declaration that no longer tells the truth: half the amount,
      // and a goal that names nobody. A run where everything is allowed
      // proves nothing on its own -- it could equally mean the checks are
      // dead.
      // Only a declaration that carries an amount can understate one.
      // `close_account` has none, and counting it as a miss made the
      // detection rate a statement about the manifest set rather than about
      // the check.
      const hasAmount =
        typeof declaration.args["amount"] === "bigint" ||
        typeof declaration.args["amountIn"] === "bigint";
      const understated = run(toDecimalArgs(declaration, decimals, 2n), false);
      const silent = run(toDecimalArgs(declaration, decimals), true);
      if (hasAmount) {
        understatable++;
        if (understated.decision !== "allow") caught.understated++;
      }
      if (silent.decision !== "allow") caught.silent++;
      for (const finding of understated.findings) {
        if (finding.severity !== "low") bump(caughtBy, finding.rule);
      }
      for (const finding of silent.findings) {
        if (finding.severity !== "low") bump(caughtBy, finding.rule);
      }
      tampered++;

      bump(decisions, verdict.decision);
      for (const finding of verdict.findings) {
        bump(rules, `${finding.severity.padEnd(8)} ${finding.rule}`);
      }

      if (verdict.decision !== "allow" && examples.length < 12) {
        const lines = verdict.findings
          .filter((f) => f.severity !== "low")
          .map(
            (f) =>
              `      ${f.severity.padEnd(8)} ${f.rule}  ${JSON.stringify(f.detail).slice(0, 200)}`,
          );
        examples.push(
          `  slot ${slot}  ${declaration.tool}  ${verdict.decision.toUpperCase()}` +
            `  (${set.effects.length} effects)\n${lines.join("\n")}`,
        );
      }
    }
  }

  console.log(
    `\n${executed} transactions executed and evaluated` +
      `\n  ${unclassified} matched no primitive we have a manifest for`,
  );
  printCounts("decision on an honest declaration:", decisions);
  printCounts("primitive inferred:", tools);
  printCounts("every finding, by rule:", rules);

  if (tampered > 0) {
    const rate = (n: number, total: number): string =>
      total === 0
        ? "n/a"
        : `${n} of ${total} (${((n / total) * 100).toFixed(0)}%)`;
    console.log(
      `\nthe same transactions, declared dishonestly:` +
        `\n  half the amount declared      caught ${rate(caught.understated, understatable)}` +
        `\n  destination named nowhere     caught ${rate(caught.silent, tampered)}`,
    );
    printCounts("what caught them:", caughtBy);
  }

  if (examples.length > 0) {
    console.log("\nexamples that were not allowed:");
    for (const example of examples) console.log(example);
  }

  return 0;
}

process.exitCode = await main();
