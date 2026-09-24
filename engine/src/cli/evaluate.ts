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
import { readFileSync } from "node:fs";
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
import { FixtureRpcClient, loadFixture } from "../normalization/fixture.js";
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
  readonly fixture: string;
  readonly goal: string;
  /** null means: use the tool the scenario stands for. */
  readonly toolCall: string | null;
  readonly retrieved: string | null;
  readonly source: string | null;
}

function parseArgs(argv: readonly string[]): Args | string {
  let fixture: string | null = null;
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
  if (fixture === null)
    return (
      "Usage: evaluate.ts --fixture <name> --goal <text> [--retrieved <text>] [--source <url>] [--tool <name>]" +
      `\navailable fixtures: ${SCENARIOS.join(", ")}`
    );
  return { fixture, goal, toolCall, retrieved, source };
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
      console.log(`  ${short(String(detail["counterparty"] ?? "?"))}`);
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

  let raw: unknown;
  try {
    raw = JSON.parse(
      readFileSync(`test/fixtures/${args.fixture}.json`, "utf8"),
    );
  } catch (error) {
    console.error(
      `could not read fixture: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_INPUT;
  }
  const loaded = loadFixture(raw);
  if (!loaded.ok) {
    console.error(loaded.failure.message);
    return EXIT_INPUT;
  }

  const rpc = new FixtureRpcClient(loaded.value);
  const set = await normalize(rpc.transaction(), rpc);
  // The tool the scenario stands for, unless the caller named another one to
  // see what the same transaction looks like under a different manifest.
  const tool = args.toolCall ?? toolFor(args.fixture);
  const toolArgs =
    args.toolCall === null ? argsFor(args.fixture, loaded.value.before.addresses) : {};

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
    decimals: DECIMALS,
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
