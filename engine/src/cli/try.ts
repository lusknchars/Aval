/**
 * Type a prompt, see the verdict.
 *
 *   pnpm exec tsx src/cli/try.ts [--fixture <name>]
 *
 * Asks what the user wanted, then what the agent read, and evaluates a real
 * recorded transaction against that context. Runs the same code the library
 * does -- nothing here is a mock.
 *
 * The interesting move is to answer the second question with something that
 * names an address the first question never mentioned. That is prompt
 * injection, in one line.
 */
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { evaluate } from "../evaluation/verdict.js";
import { FixtureRpcClient, loadFixture } from "../normalization/fixture.js";
import { normalize } from "../normalization/normalize.js";
import { formatRawAmount } from "../normalization/spl.js";
import type { ActionContext, ContextChunk } from "../types/context.js";
import type { Effect, EffectSet } from "../types/effects.js";
import type { Verdict } from "../types/verdict.js";

const SCENARIOS = [
  "unlimited-approve",
  "transfer-sol",
  "create-ata",
  "close-account",
  "rent-failure",
];

function short(address: string): string {
  return address.length > 14
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : address;
}

function describeEffect(effect: Effect): string {
  switch (effect.type) {
    case "BALANCE_DECREASE":
    case "BALANCE_INCREASE": {
      const sign = effect.type === "BALANCE_DECREASE" ? "−" : "+";
      const mint = effect.mint ?? "?";
      return mint === "SOL" && effect.amount !== undefined
        ? `${sign}${formatRawAmount(effect.amount, 9)} SOL`
        : `${sign}${effect.amount ?? "?"} ${short(mint)}`;
    }
    case "DELEGATE_GRANT": {
      const unlimited =
        effect.amount !== undefined &&
        effect.amount >= 18_446_744_073_709_551_615n;
      return `delegate → ${short(effect.counterparty ?? "?")}${unlimited ? "  UNLIMITED" : ""}`;
    }
    case "AUTHORITY_CHANGE":
      return `${effect.authorityKind ?? "?"} authority → ${short(effect.counterparty ?? "none")}`;
    case "OWNER_CHANGE":
      return `owner → ${short(effect.counterparty ?? "?")}`;
    case "ACCOUNT_CREATE":
      return `account created ${short(effect.account)}`;
    case "ACCOUNT_CLOSE":
      return `account closed ${short(effect.account)}`;
    case "PROGRAM_INVOKE":
      return `program ${short(effect.program ?? effect.account)}`;
    default:
      return effect.type;
  }
}

function report(set: EffectSet, verdict: Verdict): void {
  console.log(`\n  ${verdict.decision.toUpperCase()}\n`);

  console.log("  what the transaction would do");
  for (const effect of set.effects)
    console.log(`    ${describeEffect(effect)}`);

  const provenance = verdict.findings.filter((f) => f.check === "provenance");
  if (provenance.length > 0) {
    console.log("\n  where the counterparty came from");
    for (const finding of provenance) {
      const provenances = Array.isArray(finding.detail["provenances"])
        ? finding.detail["provenances"]
        : [];
      const where =
        provenances.length === 0
          ? "nowhere in the captured context"
          : provenances.join(", ");
      console.log(
        `    ${short(String(finding.detail["counterparty"] ?? "?"))}  →  ${where}`,
      );
    }
  }

  console.log("\n  findings");
  if (verdict.findings.length === 0) console.log("    none");
  for (const finding of verdict.findings) {
    console.log(
      `    ${finding.severity.toUpperCase().padEnd(9)} ${finding.rule}`,
    );
  }
  console.log(`\n  policy ${verdict.policyVersion}\n`);
}

function contextOf(goal: string, read: string, source: string): ActionContext {
  const chunks: ContextChunk[] = [{ text: goal, provenance: "user" }];
  if (read !== "") {
    chunks.push({
      text: read,
      provenance: "retrieved",
      ...(source === "" ? {} : { source }),
    });
  }
  return {
    actionId: `try-${Date.now()}`,
    agentId: "try",
    userGoal: goal,
    systemPrompt: "",
    contextChunks: chunks,
    toolCall: { name: "swap", args: {} },
    unsignedTx: emptyTx(),
    timestamp: Date.now(),
  };
}

function emptyTx(): VersionedTransaction {
  const key = PublicKey.default;
  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: key,
      recentBlockhash: key.toBase58(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: key,
          toPubkey: key,
          lamports: 1n,
        }),
      ],
    }).compileToV0Message(),
  );
}

async function main(): Promise<number> {
  const flagIndex = process.argv.indexOf("--fixture");
  const chosen =
    flagIndex >= 0 ? (process.argv[flagIndex + 1] ?? "") : "unlimited-approve";
  if (!SCENARIOS.includes(chosen)) {
    console.error(
      `unknown fixture: ${chosen}\navailable: ${SCENARIOS.join(", ")}`,
    );
    return 1;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(`test/fixtures/${chosen}.json`, "utf8"));
  } catch (error) {
    console.error(
      `could not read fixture: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  const loaded = loadFixture(raw);
  if (!loaded.ok) {
    console.error(loaded.failure.message);
    return 1;
  }

  const rpc = new FixtureRpcClient(loaded.value);
  const set = await normalize(rpc.transaction(), rpc);
  const counterparty =
    set.effects.find((e) => e.counterparty !== undefined)?.counterparty ?? null;

  console.log(
    `\ntransaction: ${chosen}  (recorded on devnet, ${set.effects.length} effects)`,
  );
  if (counterparty !== null) {
    console.log("\nits counterparty is:\n");
    console.log(`  ${counterparty}\n`);
    console.log(
      "copy that whole line into the second answer to see the attack,",
    );
    console.log(
      "or into the first one to see what changes when the user asked for it.",
    );
  }
  console.log("empty input at the first question exits.\n");

  // Piped input runs one round and exits, so a demo can be scripted. A real
  // terminal loops, so variations can be tried side by side.
  if (process.stdin.isTTY !== true) {
    const piped = readFileSync(0, "utf8").split("\n");
    const goal = (piped[0] ?? "").trim();
    if (goal === "") {
      console.error(
        "nothing on stdin: expected goal, then what the agent read, then the source",
      );
      return 1;
    }
    report(
      set,
      evaluate({
        effects: set,
        context: contextOf(
          goal,
          (piped[1] ?? "").trim(),
          (piped[2] ?? "").trim(),
        ),
      }),
    );
    return 0;
  }

  const io = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const goal = (await io.question("what did the user ask for?  ")).trim();
      if (goal === "") break;
      const read = (await io.question("what did the agent read?     ")).trim();
      const source =
        read === ""
          ? ""
          : (await io.question("source of that content?      ")).trim();
      report(
        set,
        evaluate({ effects: set, context: contextOf(goal, read, source) }),
      );
    }
  } finally {
    io.close();
  }

  return 0;
}

process.exitCode = await main();
