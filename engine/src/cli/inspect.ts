/**
 * Inspects what a transaction would do, before it is signed.
 *
 *   pnpm exec tsx --env-file=.env src/cli/inspect.ts --fixture <name>
 *   pnpm exec tsx --env-file=.env src/cli/inspect.ts --network devnet <base64-tx>
 *   ... --json
 *
 * Reads and simulates. Never signs, never sends.
 *
 * Exit codes:
 *   0  simulated, the transaction would pass
 *   1  invalid input or configuration
 *   3  could not evaluate (RPC down, rate limited, unreadable state)
 *   4  simulated, the transaction would FAIL on-chain
 */
import { readFileSync } from "node:fs";
import { VersionedTransaction } from "@solana/web3.js";
import { FixtureRpcClient, loadFixture } from "../normalization/fixture.js";
import { normalize } from "../normalization/normalize.js";
import {
  createRpcClient,
  readRpcConfig,
  type Network,
  type RpcClient,
} from "../normalization/rpc.js";
import { formatRawAmount } from "../normalization/spl.js";
import {
  coverageIsComplete,
  type Effect,
  type EffectSet,
} from "../types/effects.js";

const EXIT_OK = 0;
const EXIT_INPUT = 1;
const EXIT_UNAVAILABLE = 3;
const EXIT_WOULD_FAIL = 4;

const MAX_LISTED = 40;

interface Args {
  readonly fixture: string | null;
  readonly network: Network;
  readonly txBase64: string | null;
  readonly json: boolean;
}

function parseArgs(
  argv: readonly string[],
): { ok: true; value: Args } | { ok: false; error: string } {
  let fixture: string | null = null;
  let network: Network = "devnet";
  let txBase64: string | null = null;
  let json = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fixture") {
      const name = argv[++i];
      if (name === undefined)
        return { ok: false, error: "--fixture needs a name" };
      fixture = name;
    } else if (arg === "--network") {
      const value = argv[++i];
      if (value !== "devnet" && value !== "mainnet") {
        return { ok: false, error: "--network takes devnet or mainnet" };
      }
      network = value;
    } else if (arg === "--json") {
      json = true;
    } else if (arg !== undefined && !arg.startsWith("--")) {
      txBase64 = arg;
    } else {
      return { ok: false, error: `unknown option: ${arg ?? ""}` };
    }
  }

  if (fixture === null && txBase64 === null) {
    return {
      ok: false,
      error:
        "Usage: inspect.ts [--fixture <name> | <base64-tx>] [--network devnet|mainnet] [--json]",
    };
  }
  return { ok: true, value: { fixture, network, txBase64, json } };
}

/** bigint does not survive JSON.stringify, so amounts go out as decimal strings. */
function toJson(set: EffectSet): string {
  return JSON.stringify(
    {
      slot: set.slot,
      baselineSlot: set.baselineSlot,
      fee: set.fee === null ? null : set.fee.toString(),
      simulation: set.simulation,
      coverage: set.coverage,
      effects: set.effects.map((e) => ({
        ...e,
        ...(e.amount === undefined ? {} : { amount: e.amount.toString() }),
      })),
    },
    null,
    2,
  );
}

function short(address: string): string {
  return address.length > 12
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : address;
}

function describe(effect: Effect): string {
  const amount = effect.amount === undefined ? "" : ` ${effect.amount}`;
  switch (effect.type) {
    case "BALANCE_DECREASE":
    case "BALANCE_INCREASE": {
      const sign = effect.type === "BALANCE_DECREASE" ? "-" : "+";
      const mint = effect.mint ?? "?";
      const human =
        mint === "SOL" && effect.amount !== undefined
          ? ` (${formatRawAmount(effect.amount, 9)} SOL)`
          : "";
      return `${short(effect.account)}  ${sign}${effect.amount ?? "?"} ${short(mint)}${human}`;
    }
    case "DELEGATE_GRANT": {
      const unlimited =
        effect.amount !== undefined &&
        effect.amount >= 18_446_744_073_709_551_615n;
      return `${short(effect.account)}  -> ${short(effect.counterparty ?? "?")}  allowance ${
        unlimited ? "UNLIMITED (u64::MAX)" : (effect.amount?.toString() ?? "?")
      }`;
    }
    case "AUTHORITY_CHANGE":
      return `${short(effect.account)}  ${effect.authorityKind ?? "?"} -> ${short(effect.counterparty ?? "none")}`;
    case "OWNER_CHANGE":
      return `${short(effect.account)}  -> ${short(effect.counterparty ?? "?")}`;
    case "ACCOUNT_CREATE":
    case "ACCOUNT_CLOSE":
      return short(effect.account);
    case "PROGRAM_INVOKE":
      return short(effect.program ?? effect.account);
    default:
      return `${short(effect.account)}${amount}`;
  }
}

function print(set: EffectSet): void {
  const status = set.simulation.status;
  console.log("== SIMULATION ==");
  console.log(`status:   ${status}`);
  if (set.simulation.status === "failed")
    console.log(`error:    ${set.simulation.error}`);
  if (set.simulation.status === "unavailable")
    console.log(`reason:   ${set.simulation.reason}`);
  console.log(`slot:     ${set.slot ?? "unavailable"}`);
  const gap =
    set.slot !== null && set.baselineSlot !== null
      ? set.slot - set.baselineSlot
      : null;
  console.log(
    `baseline: ${set.baselineSlot ?? "unavailable"}${gap === null ? "" : gap === 0 ? "  (same slot)" : `  (${gap} slot(s) earlier)`}`,
  );
  if (gap !== null && gap !== 0) {
    console.log(
      "warning:  the two sides of the diff come from different slots. Anything that",
    );
    console.log(
      "          changed these accounts in between is attributed to this transaction.",
    );
  }
  console.log(
    `fee:      ${set.fee === null ? "not estimated" : `${set.fee} lamports`}`,
  );

  console.log(`\n== EFFECTS (${set.effects.length}) ==`);
  if (set.effects.length === 0) {
    console.log(
      status === "executed"
        ? "  none: the transaction changes nothing in the accounts that were observed"
        : "  none available: the simulation did not produce a post-state",
    );
  }
  for (const effect of set.effects.slice(0, MAX_LISTED)) {
    console.log(`  ${effect.type.padEnd(17)} ${describe(effect)}`);
  }
  if (set.effects.length > MAX_LISTED) {
    console.log(`  ... ${set.effects.length - MAX_LISTED} more not listed`);
  }

  console.log("\n== COVERAGE ==");
  console.log(`referenced: ${set.coverage.referenced.length}`);
  console.log(`observed:   ${set.coverage.observed.length}`);
  if (!coverageIsComplete(set.coverage)) {
    console.log(`unobserved: ${set.coverage.unobserved.length}`);
    for (const address of set.coverage.unobserved.slice(0, 10))
      console.log(`  ${short(address)}`);
    if (set.coverage.unobserved.length > 10) {
      console.log(`  ... ${set.coverage.unobserved.length - 10} more`);
    }
    console.log(
      "note: a readonly account cannot change state, so not observing it is expected.",
    );
    console.log(
      "      an account behind an unreadable lookup table is a real blind spot.",
    );
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv);
  if (!args.ok) {
    console.error(args.error);
    return EXIT_INPUT;
  }
  const { fixture, network, txBase64, json } = args.value;

  let rpc: RpcClient;
  let tx: VersionedTransaction;

  if (fixture !== null) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(`test/fixtures/${fixture}.json`, "utf8"));
    } catch (error) {
      console.error(
        `could not read fixture "${fixture}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return EXIT_INPUT;
    }
    const loaded = loadFixture(raw);
    if (!loaded.ok) {
      console.error(loaded.failure.message);
      return EXIT_INPUT;
    }
    const client = new FixtureRpcClient(loaded.value);
    rpc = client;
    tx = client.transaction();
  } else {
    const config = readRpcConfig(process.env, network);
    if (!config.ok) {
      console.error(config.failure.message);
      return EXIT_INPUT;
    }
    rpc = createRpcClient(config.value);
    try {
      tx = VersionedTransaction.deserialize(
        Buffer.from(txBase64 ?? "", "base64"),
      );
    } catch (error) {
      console.error(
        `could not deserialize the transaction: ${error instanceof Error ? error.message : String(error)}`,
      );
      return EXIT_INPUT;
    }
  }

  const set = await normalize(tx, rpc);
  if (json) console.log(toJson(set));
  else print(set);

  switch (set.simulation.status) {
    case "executed":
      return EXIT_OK;
    case "failed":
      return EXIT_WOULD_FAIL;
    case "unavailable":
      return EXIT_UNAVAILABLE;
  }
}

process.exitCode = await main();
