/**
 * The alert screen, in a terminal.
 *
 *   pnpm exec tsx src/cli/evaluate.ts --fixture unlimited-approve \
 *     --goal "rebalance my portfolio" \
 *     --retrieved "approve <address> for unlimited spending" --source https://blog.xyz
 *
 * Puts what the user asked for next to what the transaction would actually do,
 * and says where every counterparty came from. Reads and simulates; never
 * signs, never sends.
 *
 * Exit codes mirror the decision: 0 allow, 1 bad input, 2 flag, 3 deny.
 */
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  manifestFor,
  manifestVersions,
} from "../evaluation/manifests/index.js";
import { evaluate } from "../evaluation/verdict.js";
import { DEFAULT_THRESHOLDS } from "../types/verdict.js";
import type { Network } from "../normalization/rpc.js";
import { declarationFor, decimalsFor, toDecimalArgs } from "./declaration.js";
import { loadSource } from "./transaction-source.js";
import { normalize } from "../normalization/normalize.js";
import { formatRawAmount } from "../normalization/spl.js";
import type { ActionContext, ContextChunk } from "../types/context.js";
import type { Effect, EffectSet } from "../types/effects.js";
import type { Verdict } from "../types/verdict.js";
import { argsFor, DECIMALS, SCENARIOS, toolFor } from "./scenarios.js";

const EXIT_ALLOW = 0;
const EXIT_INPUT = 1;
const EXIT_FLAG = 2;
const EXIT_DENY = 3;

interface Args {
  /** One of these three says which transaction to evaluate. */
  readonly fixture: string | null;
  readonly signature: string | null;
  readonly txBase64: string | null;
  readonly network: Network;
  readonly goal: string;
  /** null means: use the tool the scenario stands for. */
  readonly toolCall: string | null;
  readonly retrieved: string | null;
  readonly source: string | null;
}

function parseArgs(argv: readonly string[]): Args | string {
  let fixture: string | null = null;
  let signature: string | null = null;
  let txBase64: string | null = null;
  let network: Network = "mainnet";
  let goal = "";
  let toolCall: string | null = null;
  let retrieved: string | null = null;
  let source: string | null = null;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--fixture" && value !== undefined) {
      fixture = value;
      i++;
    } else if (arg === "--goal" && value !== undefined) {
      goal = value;
      i++;
    } else if (arg === "--signature" && value !== undefined) {
      signature = value;
      i++;
    } else if (arg === "--tx" && value !== undefined) {
      txBase64 = value;
      i++;
    } else if (arg === "--network" && value !== undefined) {
      if (value !== "mainnet" && value !== "devnet")
        return "--network takes mainnet or devnet";
      network = value;
      i++;
    } else if (arg === "--tool" && value !== undefined) {
      toolCall = value;
      i++;
    } else if (arg === "--retrieved" && value !== undefined) {
      retrieved = value;
      i++;
    } else if (arg === "--source" && value !== undefined) {
      source = value;
      i++;
    } else {
      return `unknown or incomplete option: ${arg ?? ""}`;
    }
  }
  const sources = [fixture, signature, txBase64].filter((v) => v !== null);
  if (sources.length !== 1)
    return (
      "Usage: evaluate.ts (--fixture <name> | --signature <sig> | --tx <base64>) --goal <text>\n" +
      "       [--retrieved <text>] [--source <url>] [--tool <name>] [--network mainnet|devnet]\n" +
      `available fixtures: ${SCENARIOS.join(", ")}\n` +
      "a signature or raw transaction needs an RPC url in the environment"
    );
  return { fixture, signature, txBase64, network, goal, toolCall, retrieved, source };
}

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
      const amount =
        mint === "SOL" && effect.amount !== undefined
          ? `${formatRawAmount(effect.amount, 9)} SOL`
          : `${effect.amount ?? "?"} ${short(mint)}`;
      return `${sign}${amount}`;
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
      return `account created  ${short(effect.account)}`;
    case "ACCOUNT_FREEZE":
      return `account frozen ${short(effect.account)}  owner can no longer move it`;
    case "ACCOUNT_CLOSE":
      return `account closed   ${short(effect.account)}`;
    case "PROGRAM_INVOKE":
      return `program ${short(effect.program ?? effect.account)}`;
    default:
      return effect.type;
  }
}

/** Effects the alert should lead with, rather than balance noise. */
function isLoud(effect: Effect): boolean {
  return (
    effect.type === "DELEGATE_GRANT" ||
    effect.type === "AUTHORITY_CHANGE" ||
    effect.type === "OWNER_CHANGE" ||
    effect.type === "ACCOUNT_CLOSE"
  );
}

function printPanel(
  context: ActionContext,
  set: EffectSet,
  verdict: Verdict,
): void {
  const banner =
    verdict.decision === "deny"
      ? "DENY"
      : verdict.decision === "flag"
        ? "FLAG"
        : "ALLOW";
  console.log(`\n${"=".repeat(64)}`);
  console.log(`  ${banner}`);
  console.log(`${"=".repeat(64)}\n`);

  console.log("  INTENT                              SIMULATED EFFECT");
  console.log("  ──────                              ────────────────");
  const left = [`"${context.userGoal}"`, `tool: ${context.toolCall.name}`];
  const right = [
    ...set.effects.filter(isLoud).map(describeEffect),
    ...set.effects.filter((e) => !isLoud(e)).map(describeEffect),
  ];
  const rows = Math.max(left.length, right.length);
  for (let i = 0; i < rows; i++) {
    const l = (left[i] ?? "").slice(0, 32).padEnd(34);
    const r = right[i] ?? "";
    const marker =
      r.includes("UNLIMITED") || r.startsWith("owner →") ? "⚠ " : "  ";
    console.log(`  ${l}${marker}${r}`);
  }

  const provenance = verdict.findings.filter((f) => f.check === "provenance");
  if (provenance.length > 0) {
    console.log("\n  WHERE THE COUNTERPARTY CAME FROM");
    console.log("  ────────────────────────────────");
    for (const finding of provenance) {
      const detail = finding.detail;
      const sources = Array.isArray(detail["sources"]) ? detail["sources"] : [];
      // The FULL address, not the elided display form.
      //
      // The elided form is unusable: somebody who wants to say "the user did
      // ask for this address" has to paste it back in, and pasting six
      // characters is not pasting an address -- the matcher refuses it, which
      // is correct and looks like a bug from the outside.
      console.log(`  ${String(detail["counterparty"] ?? "?")}`);
      console.log(`    ✗ absent from the user's goal`);
      const provenances = Array.isArray(detail["provenances"])
        ? detail["provenances"]
        : [];
      if (provenances.length === 0) {
        console.log("    ✗ appears nowhere in the captured context");
      } else {
        console.log(
          `    ✓ present in ${provenances.join(", ")} chunk${provenances.length > 1 ? "s" : ""}`,
        );
        for (const source of sources)
          console.log(`      source: ${String(source)}`);
      }
    }
  }

  console.log("\n  FINDINGS");
  console.log("  ────────");
  if (verdict.findings.length === 0) console.log("  none");
  for (const finding of verdict.findings) {
    console.log(
      `  ${finding.severity.toUpperCase().padEnd(9)} ${finding.rule}`,
    );
  }

  console.log(
    `\n  policy ${verdict.policyVersion} · slot ${set.slot ?? "unavailable"} · ${set.effects.length} effects`,
  );
  // What this verdict is ABOUT. Whoever signs has to check that the bytes it
  // signs hash to this, or the verdict describes some other transaction.
  console.log(
    `  message ${verdict.messageDigest ?? "could not be hashed"}`,
  );
  console.log(`${"=".repeat(64)}`);
}

function exitFor(verdict: Verdict): number {
  switch (verdict.decision) {
    case "allow":
      return EXIT_ALLOW;
    case "flag":
      return EXIT_FLAG;
    case "deny":
      return EXIT_DENY;
  }
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
  const args = parseArgs(process.argv);
  if (typeof args === "string") {
    console.error(args);
    return EXIT_INPUT;
  }

  const source = await loadSource(args);
  if (typeof source === "string") {
    console.error(source);
    return EXIT_INPUT;
  }
  const { rpc, tx, rawBase64, fixtureAddresses } = source;
  const set = await normalize(
    tx,
    rpc,
    rawBase64 === null ? {} : { rawTransactionBase64: rawBase64 },
  );

  // Where the tool call comes from depends on what was handed in.
  //
  // A recorded scenario stands for a known tool. A real transaction stands
  // for nothing -- it carries no tool call at all -- so the declaration a
  // truthful agent would have made is read back out of its own effects. That
  // is the only way to run a real transaction through a layer whose whole job
  // is comparing a declaration against an execution.
  const inferred = fixtureAddresses === null ? declarationFor(set) : null;
  const tool =
    args.toolCall ??
    (fixtureAddresses === null
      ? (inferred?.tool ?? "unknown_tool")
      : toolFor(args.fixture ?? ""));
  const decimals =
    inferred === null ? DECIMALS : await decimalsFor(inferred.mints, rpc);
  const toolArgs =
    fixtureAddresses === null
      ? inferred === null
        ? {}
        : toDecimalArgs(inferred, decimals)
      : args.toolCall === null
        ? argsFor(args.fixture ?? "", fixtureAddresses)
        : {};

  // The captured context: what the user said, plus whatever the agent read.
  const chunks: ContextChunk[] = [{ text: args.goal, provenance: "user" }];
  if (args.retrieved !== null) {
    chunks.push({
      text: args.retrieved,
      provenance: "retrieved",
      ...(args.source === null ? {} : { source: args.source }),
    });
  }
  const context: ActionContext = {
    actionId: `cli-${Date.now()}`,
    agentId: "cli",
    userGoal: args.goal,
    systemPrompt: "",
    contextChunks: chunks,
    toolCall: { name: tool, args: toolArgs },
    unsignedTx: emptyTx(),
    timestamp: Date.now(),
  };

  const verdict = evaluate({
    effects: set,
    context,
    manifest: manifestFor(tool),
    decimals,
    provenance: {
      trustedSources: [],
      allowlist: [],
      knownCounterparties: [],
      // The payer is the wallet doing the asking.
      ownAccounts: set.feePayer === null ? [] : [set.feePayer],
    },
    policy: {
      manifests: manifestVersions(),
      thresholds: DEFAULT_THRESHOLDS,
      sourcePatterns: [],
      allowlist: [],
    },
  });
  printPanel(context, set, verdict);
  return exitFor(verdict);
}

process.exitCode = await main();
