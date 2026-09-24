/**
 * Exploration script: inspects a CONFIRMED mainnet transaction.
 *
 *   pnpm exec tsx --env-file=.env test/exploration/inspect-transaction.ts <signature>
 *
 * Historical read through getTransaction -- not a simulation. It does not
 * sign, send, decode protocol instructions, or produce an EffectSet.
 *
 * Exit codes:
 *   0  transaction found and executed successfully
 *   1  invalid input or configuration (including an RPC that is not mainnet)
 *   2  the RPC answered, but the transaction was not found
 *   3  RPC failure (network, auth, rate limit, unsupported version)
 *   4  transaction found, but it FAILED on-chain (meta.err)
 *   5  transaction found, but it carries no meta: status unknown
 */
import {
  Connection,
  type Finality,
  type TokenBalance,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

// Highest version the installed @solana/web3.js can deserialize (legacy, 0, 1).
// Asking for more would hand back a transaction the SDK cannot read.
const MAX_SUPPORTED_VERSION = 1;

const EXIT_OK = 0;
const EXIT_INPUT = 1;
const EXIT_NOT_FOUND = 2;
const EXIT_RPC = 3;
const EXIT_TX_FAILED = 4;
const EXIT_NO_META = 5;

// Print limits. Anything beyond them is counted and announced, never dropped.
const MAX_ACCOUNTS = 64;
const MAX_INSTRUCTIONS = 20;
const MAX_INNER_PER_OUTER = 12;
const MAX_ACCOUNTS_PER_INSTRUCTION = 12;
const MAX_DATA_CHARS = 48;

const urlSchema = z.url({ protocol: /^https?$/ });
const commitmentSchema = z.enum(["processed", "confirmed", "finalized"]);

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
type Config = { rpcUrl: string; commitment: Finality };

// ---------------------------------------------------------------- input

function readConfig(env: NodeJS.ProcessEnv): Result<Config> {
  const url = env["VETO_RPC_URL"];
  if (url === undefined || url === "") return { ok: false, error: "VETO_RPC_URL is not set. Fill it in .env." };
  if (!urlSchema.safeParse(url).success) return { ok: false, error: "VETO_RPC_URL is not a valid http(s) URL." };

  const parsed = commitmentSchema.safeParse(env["VETO_RPC_COMMITMENT"]);
  if (!parsed.success) {
    return { ok: false, error: "VETO_RPC_COMMITMENT missing or invalid. Use processed, confirmed or finalized." };
  }
  const commitment = parsed.data;
  if (commitment === "processed") {
    // getTransaction only accepts Finality: the RPC rejects "processed".
    return {
      ok: false,
      error: "VETO_RPC_COMMITMENT=processed does not work for getTransaction (only confirmed or finalized).",
    };
  }
  return { ok: true, value: { rpcUrl: url, commitment } };
}

function readSignature(argv: readonly string[]): Result<string> {
  const input = argv[2];
  if (input === undefined || argv.length > 3) {
    return { ok: false, error: "Usage: inspect-transaction.ts <base58-signature>" };
  }
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(input);
  } catch {
    return { ok: false, error: `Invalid signature: "${input}" is not base58.` };
  }
  if (bytes.length !== 64) {
    return {
      ok: false,
      error: `Invalid signature: decodes to ${bytes.length} bytes; an Ed25519 signature is 64.`,
    };
  }
  return { ok: true, value: input };
}

function redact(text: string, rpcUrl: string): string {
  return text.split(rpcUrl).join("<mainnet-rpc>").replace(/api-key=[^&\s"']+/gi, "api-key=***");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------- accounts

type Account = {
  index: number;
  address: string;
  origin: "static" | "ALT writable" | "ALT readonly";
  signer: boolean;
  writable: boolean;
  alt: { table: string; index: number } | null;
};

/**
 * Builds the account list in the order the instruction indexes use: static
 * first, then the writable entries of every lookup table, then the readonly.
 */
function resolveAccounts(tx: VersionedTransactionResponse): { accounts: Account[]; warnings: string[] } {
  const msg = tx.transaction.message;
  const h = msg.header;
  const staticKeys = msg.staticAccountKeys;
  const warnings: string[] = [];

  // signer/writable of static keys come from position plus the header:
  // [writable signers][readonly signers][writable non-signers][readonly non-signers]
  const accounts: Account[] = staticKeys.map((pk, i) => {
    const signer = i < h.numRequiredSignatures;
    const writable = signer
      ? i < h.numRequiredSignatures - h.numReadonlySignedAccounts
      : i < staticKeys.length - h.numReadonlyUnsignedAccounts;
    return { index: i, address: pk.toBase58(), origin: "static", signer, writable, alt: null };
  });

  const lookups = msg.addressTableLookups;
  if (lookups.length === 0) return { accounts, warnings };

  const loaded = tx.meta?.loadedAddresses;
  if (loaded === undefined) {
    warnings.push(
      `the tx uses ${lookups.length} lookup table(s), but the RPC returned no meta.loadedAddresses: ` +
        `indexes above ${staticKeys.length - 1} stay unresolved.`,
    );
    return { accounts, warnings };
  }

  const writableOrigins = lookups.flatMap((l) =>
    l.writableIndexes.map((i) => ({ table: l.accountKey.toBase58(), index: i })),
  );
  const readonlyOrigins = lookups.flatMap((l) =>
    l.readonlyIndexes.map((i) => ({ table: l.accountKey.toBase58(), index: i })),
  );
  if (writableOrigins.length !== loaded.writable.length || readonlyOrigins.length !== loaded.readonly.length) {
    warnings.push("loadedAddresses count does not match the lookup indexes; per-table origin may be wrong.");
  }

  loaded.writable.forEach((pk, k) => {
    accounts.push({
      index: accounts.length,
      address: pk.toBase58(),
      origin: "ALT writable",
      signer: false,
      writable: true,
      alt: writableOrigins[k] ?? null,
    });
  });
  loaded.readonly.forEach((pk, k) => {
    accounts.push({
      index: accounts.length,
      address: pk.toBase58(),
      origin: "ALT readonly",
      signer: false,
      writable: false,
      alt: readonlyOrigins[k] ?? null,
    });
  });
  return { accounts, warnings };
}

// ---------------------------------------------------------------- formatting

function limit<T>(items: readonly T[], max: number): { visible: readonly T[]; omitted: number } {
  return { visible: items.slice(0, max), omitted: Math.max(0, items.length - max) };
}

function announceTruncation(omitted: number, what: string, indent = "  "): void {
  if (omitted > 0) console.log(`${indent}... ${omitted} ${what} omitted by the print limit`);
}

function accountLabel(accounts: readonly Account[], i: number): string {
  const a = accounts[i];
  return a === undefined ? `#${i} <unresolved>` : `#${i} ${a.address}`;
}

function summariseData(bytes: Uint8Array): string {
  if (bytes.length === 0) return "0 bytes";
  const b58 = bs58.encode(bytes);
  const body = b58.length > MAX_DATA_CHARS ? `${b58.slice(0, MAX_DATA_CHARS)}...` : b58;
  return `${bytes.length} bytes, base58 ${body}`;
}

function signed(n: bigint): string {
  return n > 0n ? `+${n}` : `${n}`;
}

/** Raw amount (integer string) -> exact decimal, never passing through number. */
function formatRaw(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const s = (negative ? -raw : raw).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const fraction = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

function rawToBigint(amount: string): bigint | null {
  return /^\d+$/.test(amount) ? BigInt(amount) : null;
}

// ---------------------------------------------------------------- sections

function printSummary(tx: VersionedTransactionResponse, commitment: Finality): void {
  const bt = tx.blockTime;
  console.log("== SUMMARY  (historical, via getTransaction -- NOT a simulation) ==");
  console.log(`signature:  ${tx.transaction.signatures[0] ?? "<missing>"}`);
  console.log(`slot:       ${tx.slot}`);
  console.log(
    `blockTime:  ${bt === null || bt === undefined ? "unavailable" : `${new Date(bt * 1000).toISOString()} (UTC)`}`,
  );
  console.log(`version:    ${tx.version === undefined ? "not reported" : String(tx.version)}`);
  const msg = tx.transaction.message;
  if ("transactionConfig" in msg) {
    // In v1 the compute budget is a message field, not a ComputeBudget instruction.
    const c = msg.transactionConfig;
    console.log(
      `v1 config:  computeUnitLimit=${c.computeUnitLimit ?? "-"} priorityFee=${c.priorityFee ?? "-"} ` +
        `heapSize=${c.heapSize ?? "-"} loadedAccountsDataSizeLimit=${c.loadedAccountsDataSizeLimit ?? "-"}`,
    );
  }
  console.log(`commitment: ${commitment}`);
  if (tx.meta === null) {
    console.log("status:     UNKNOWN (the RPC returned no meta)");
    console.log("fee:        unavailable");
    return;
  }
  console.log(
    `status:     ${tx.meta.err === null ? "success" : `FAILED on-chain: ${JSON.stringify(tx.meta.err)}`}`,
  );
  console.log(`fee:        ${tx.meta.fee} lamports`);
}

function printAccounts(accounts: readonly Account[], warnings: readonly string[]): void {
  const staticCount = accounts.filter((a) => a.origin === "static").length;
  console.log(
    `\n== ACCOUNTS  (${accounts.length} total: ${staticCount} static, ${accounts.length - staticCount} via lookup table) ==`,
  );
  for (const w of warnings) console.log(`  warning: ${w}`);
  const { visible, omitted } = limit(accounts, MAX_ACCOUNTS);
  for (const a of visible) {
    const flags = `${a.signer ? "S" : "-"}${a.writable ? "W" : "-"}`;
    const alt = a.alt === null ? "" : `  [table ${a.alt.table} idx ${a.alt.index}]`;
    console.log(`  #${String(a.index).padStart(2)} ${flags} ${a.address}  ${a.origin}${alt}`);
  }
  announceTruncation(omitted, "account(s)");
  console.log("  legend: S = signer, W = writable (as declared in the message)");
}

function printOuterInstructions(tx: VersionedTransactionResponse, accounts: readonly Account[]): void {
  const ixs = tx.transaction.message.compiledInstructions;
  console.log(`\n== OUTER INSTRUCTIONS  (${ixs.length}) ==`);
  const { visible, omitted } = limit(ixs, MAX_INSTRUCTIONS);
  visible.forEach((ix, n) => {
    console.log(`  [${n}] program ${accountLabel(accounts, ix.programIdIndex)}`);
    const accs = limit(ix.accountKeyIndexes, MAX_ACCOUNTS_PER_INSTRUCTION);
    for (const i of accs.visible) console.log(`        account ${accountLabel(accounts, i)}`);
    announceTruncation(accs.omitted, "account(s)", "        ");
    console.log(`        data  ${summariseData(ix.data)}`);
  });
  announceTruncation(omitted, "instruction(s)");
}

function printInnerInstructions(tx: VersionedTransactionResponse, accounts: readonly Account[]): void {
  console.log("\n== INNER INSTRUCTIONS (CPI) ==");
  const inner = tx.meta?.innerInstructions;
  if (tx.meta === null || inner === undefined || inner === null) {
    console.log("  unavailable: the RPC returned no innerInstructions for this transaction");
    return;
  }
  if (inner.length === 0) {
    console.log("  none: no program called another program (CPI)");
    return;
  }
  for (const group of inner) {
    console.log(`  from outer [${group.index}]: ${group.instructions.length} inner instruction(s)`);
    const { visible, omitted } = limit(group.instructions, MAX_INNER_PER_OUTER);
    visible.forEach((ix, n) => {
      let data: string;
      try {
        data = summariseData(bs58.decode(ix.data));
      } catch {
        data = "<data is not valid base58>";
      }
      const accs = limit(ix.accounts, MAX_ACCOUNTS_PER_INSTRUCTION);
      console.log(`    (${n}) program ${accountLabel(accounts, ix.programIdIndex)}`);
      console.log(
        `          accounts ${accs.visible.map((i) => `#${i}`).join(" ")}${accs.omitted > 0 ? ` (+${accs.omitted})` : ""}`,
      );
      console.log(`          data     ${data}`);
    });
    announceTruncation(omitted, "inner instruction(s)", "    ");
  }
}

function printSolBalances(tx: VersionedTransactionResponse, accounts: readonly Account[]): void {
  console.log("\n== SOL BALANCES (lamports) ==");
  if (tx.meta === null) {
    console.log("  unavailable: no meta");
    return;
  }
  const { preBalances: pre, postBalances: post } = tx.meta;
  if (pre.length !== accounts.length || post.length !== accounts.length) {
    console.log(
      `  warning: pre=${pre.length}, post=${post.length}, accounts=${accounts.length}; indexes may not line up`,
    );
  }
  let unchanged = 0;
  const total = Math.max(pre.length, post.length);
  for (let i = 0; i < total; i++) {
    const p = pre[i];
    const q = post[i];
    if (p === undefined || q === undefined) {
      console.log(`  ${accountLabel(accounts, i)}  pre=${p ?? "missing"} post=${q ?? "missing"}`);
      continue;
    }
    if (p === q) {
      unchanged++;
      continue;
    }
    // bigint is exact here only because both are already safe integers.
    const delta =
      Number.isSafeInteger(p) && Number.isSafeInteger(q)
        ? signed(BigInt(q) - BigInt(p))
        : "imprecise (above 2^53-1, already rounded on arrival)";
    console.log(`  ${accountLabel(accounts, i)}`);
    console.log(`        pre ${p}  post ${q}  delta ${delta}`);
  }
  console.log(`  ${unchanged} account(s) with unchanged SOL balance (not listed)`);
}

function printTokenBalances(tx: VersionedTransactionResponse, accounts: readonly Account[]): void {
  console.log("\n== TOKEN BALANCES (paired by accountIndex + mint) ==");
  const meta = tx.meta;
  if (meta === null) {
    console.log("  unavailable: no meta");
    return;
  }
  const pre = meta.preTokenBalances;
  const post = meta.postTokenBalances;
  if (pre === null || pre === undefined || post === null || post === undefined) {
    console.log(
      `  unavailable: preTokenBalances ${pre == null ? "missing" : "ok"}, postTokenBalances ${post == null ? "missing" : "ok"}`,
    );
    return;
  }

  const pairs = new Map<
    string,
    { index: number; mint: string; pre: TokenBalance | null; post: TokenBalance | null }
  >();
  for (const b of pre) {
    pairs.set(`${b.accountIndex}:${b.mint}`, { index: b.accountIndex, mint: b.mint, pre: b, post: null });
  }
  for (const b of post) {
    const k = `${b.accountIndex}:${b.mint}`;
    const existing = pairs.get(k);
    if (existing === undefined) pairs.set(k, { index: b.accountIndex, mint: b.mint, pre: null, post: b });
    else existing.post = b;
  }
  if (pairs.size === 0) {
    console.log("  no token balances reported by the RPC");
    return;
  }

  const ordered = [...pairs.values()].sort((a, b) => a.index - b.index);
  for (const pair of ordered) {
    const ref = pair.post ?? pair.pre;
    if (ref === null) continue;
    const decimals = ref.uiTokenAmount.decimals;
    const ownerPre = pair.pre?.owner;
    const ownerPost = pair.post?.owner;
    const owner =
      ownerPre !== undefined && ownerPost !== undefined && ownerPre !== ownerPost
        ? `${ownerPre} -> ${ownerPost}  (CHANGED)`
        : (ownerPost ?? ownerPre ?? "not provided by the RPC");

    console.log(`  ${accountLabel(accounts, pair.index)}`);
    console.log(`        mint     ${pair.mint}`);
    console.log(`        owner    ${owner}`);
    console.log(`        decimals ${decimals}`);

    const side = (name: string, b: TokenBalance | null, lamportsSide: number | undefined, when: string): bigint | null => {
      if (b === null) {
        const hint =
          lamportsSide === 0
            ? `  (account had 0 lamports ${when}: likely ${name === "pre" ? "created" : "closed"} by this tx)`
            : "";
        console.log(`        ${name.padEnd(4)}     missing from the RPC -- NOT zero${hint}`);
        return null;
      }
      const raw = rawToBigint(b.uiTokenAmount.amount);
      if (raw === null) {
        console.log(`        ${name.padEnd(4)}     invalid raw amount: "${b.uiTokenAmount.amount}"`);
        return null;
      }
      // uiAmount is a float: above ~15 significant digits it is approximate.
      const digits = raw.toString().replace(/^0+/, "").length;
      const approx = digits > 15 ? "  (uiAmount approximate: raw has more than 15 digits)" : "";
      console.log(
        `        ${name.padEnd(4)}     raw "${b.uiTokenAmount.amount}"  exact ${formatRaw(raw, decimals)}  uiAmount ${b.uiTokenAmount.uiAmount ?? "null"}${approx}`,
      );
      return raw;
    };

    const rawPre = side("pre", pair.pre, meta.preBalances[pair.index], "before");
    const rawPost = side("post", pair.post, meta.postBalances[pair.index], "after");
    if (rawPre !== null && rawPost !== null) {
      const d = rawPost - rawPre;
      console.log(`        delta    raw ${signed(d)}  exact ${d > 0n ? "+" : ""}${formatRaw(d, decimals)}`);
    } else {
      console.log("        delta    not computed: one side is missing");
    }
  }
  console.log("  note: token balances only cover token account balances. Delegates, authority");
  console.log("        changes, closes of other accounts etc. do NOT show up here.");
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  const signature = readSignature(process.argv);
  if (!signature.ok) {
    console.error(signature.error);
    return EXIT_INPUT;
  }
  const config = readConfig(process.env);
  if (!config.ok) {
    console.error(config.error);
    return EXIT_INPUT;
  }
  const { rpcUrl, commitment } = config.value;
  const connection = new Connection(rpcUrl, { commitment, disableRetryOnRateLimit: true });

  let genesis: string;
  try {
    genesis = await connection.getGenesisHash();
  } catch (error) {
    console.error(`RPC failure while connecting: ${redact(messageOf(error), rpcUrl)}`);
    return EXIT_RPC;
  }
  if (genesis !== MAINNET_GENESIS) {
    console.error("VETO_RPC_URL answered, but it is not mainnet (different genesis hash). Refused.");
    return EXIT_INPUT;
  }

  let tx: VersionedTransactionResponse | null;
  try {
    // Without this parameter the RPC only returns legacy transactions.
    tx = await connection.getTransaction(signature.value, {
      commitment,
      maxSupportedTransactionVersion: MAX_SUPPORTED_VERSION,
    });
  } catch (error) {
    const text = redact(messageOf(error), rpcUrl);
    const version = /Transaction version \((\d+)\) is not supported/.exec(text);
    if (version !== null) {
      console.error(
        `The transaction exists, but it is version ${version[1]}; this SDK only reads up to version ${MAX_SUPPORTED_VERSION}.`,
      );
    } else {
      console.error(`RPC failure while fetching the transaction: ${text}`);
    }
    return EXIT_RPC;
  }
  if (tx === null) {
    console.error(
      `Transaction not found on mainnet (commitment ${commitment}): ${signature.value}\n` +
        "It may not exist, be too recent for this commitment, or fall outside the RPC's history.",
    );
    return EXIT_NOT_FOUND;
  }

  const { accounts, warnings } = resolveAccounts(tx);
  printSummary(tx, commitment);
  printAccounts(accounts, warnings);
  printOuterInstructions(tx, accounts);
  printInnerInstructions(tx, accounts);
  printSolBalances(tx, accounts);
  printTokenBalances(tx, accounts);

  if (tx.meta === null) return EXIT_NO_META;
  return tx.meta.err === null ? EXIT_OK : EXIT_TX_FAILED;
}

process.exitCode = await main();
