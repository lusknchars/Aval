/**
 * Exploration script: reads one account's metadata on devnet.
 *
 *   pnpm exec tsx --env-file=.env test/exploration/read-account.ts <address>
 *
 * Not a test (it does not end in .test.ts) and not VETO code. It only
 * validates the RPC connection and shows what getAccountInfo returns.
 *
 * Exit codes:
 *   0  account read
 *   1  invalid input or configuration (including an RPC that is not devnet)
 *   2  the RPC answered, but the account does not exist
 *   3  RPC failure (network, auth, rate limit...)
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { z } from "zod";

// The genesis hash is fixed per cluster. It proves the RPC really is devnet.
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const EXIT_OK = 0;
const EXIT_INPUT = 1;
const EXIT_NOT_FOUND = 2;
const EXIT_RPC = 3;

const urlSchema = z.url({ protocol: /^https?$/ });
const commitmentSchema = z.enum(["processed", "confirmed", "finalized"]);

type Config = { rpcUrl: string; commitment: z.infer<typeof commitmentSchema> };
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// No error message repeats the value it received: the URL carries the key.
function readConfig(env: NodeJS.ProcessEnv): Result<Config> {
  const url = env["VETO_RPC_URL_DEVNET"];
  if (url === undefined || url === "") {
    return { ok: false, error: "VETO_RPC_URL_DEVNET is not set. Fill it in .env." };
  }
  if (!urlSchema.safeParse(url).success) {
    return { ok: false, error: "VETO_RPC_URL_DEVNET is not a valid http(s) URL." };
  }

  const commitment = commitmentSchema.safeParse(env["VETO_RPC_COMMITMENT"]);
  if (!commitment.success) {
    return {
      ok: false,
      error: "VETO_RPC_COMMITMENT missing or invalid. Use processed, confirmed or finalized.",
    };
  }

  return { ok: true, value: { rpcUrl: url, commitment: commitment.data } };
}

function readAddress(argv: readonly string[]): Result<PublicKey> {
  const input = argv[2];
  if (input === undefined || argv.length > 3) {
    return { ok: false, error: "Usage: read-account.ts <base58-address>" };
  }
  try {
    // Requires base58 that decodes to exactly 32 bytes.
    return { ok: true, value: new PublicKey(input) };
  } catch {
    return { ok: false, error: `Invalid address: "${input}" is not a 32-byte base58 public key.` };
  }
}

// An SDK error may quote the URL. Erase the whole URL and any api-key.
function redact(text: string, rpcUrl: string): string {
  return text.split(rpcUrl).join("<devnet-rpc>").replace(/api-key=[^&\s"']+/gi, "api-key=***");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<number> {
  const address = readAddress(process.argv);
  if (!address.ok) {
    console.error(address.error);
    return EXIT_INPUT;
  }

  const config = readConfig(process.env);
  if (!config.ok) {
    console.error(config.error);
    return EXIT_INPUT;
  }
  const { rpcUrl, commitment } = config.value;

  // No silent retry on 429: the error surfaces instead of stalling the script.
  const connection = new Connection(rpcUrl, { commitment, disableRetryOnRateLimit: true });

  let genesis: string;
  try {
    genesis = await connection.getGenesisHash();
  } catch (error) {
    console.error(`RPC failure while connecting: ${redact(messageOf(error), rpcUrl)}`);
    return EXIT_RPC;
  }
  if (genesis !== DEVNET_GENESIS) {
    console.error("VETO_RPC_URL_DEVNET answered, but it is not devnet (different genesis hash). Refused.");
    return EXIT_INPUT;
  }

  let info: Awaited<ReturnType<Connection["getAccountInfo"]>>;
  try {
    info = await connection.getAccountInfo(address.value, { commitment });
  } catch (error) {
    console.error(`RPC failure while reading the account: ${redact(messageOf(error), rpcUrl)}`);
    return EXIT_RPC;
  }

  if (info === null) {
    console.error(`Account does not exist on devnet (commitment ${commitment}): ${address.value.toBase58()}`);
    return EXIT_NOT_FOUND;
  }

  console.log(`address:    ${address.value.toBase58()}`);
  console.log(`lamports:   ${info.lamports}`);
  console.log(`owner:      ${info.owner.toBase58()}`);
  console.log(`data:       ${info.data.length} bytes`);
  console.log(`executable: ${info.executable}`);

  // lamports arrives as a number (JSON.parse inside the SDK). Above 2^53-1 it
  // already came rounded -- converting to bigint here recovers nothing.
  if (!Number.isSafeInteger(info.lamports)) {
    console.error("warning: lamports above Number.MAX_SAFE_INTEGER; the value above may be imprecise.");
  }

  return EXIT_OK;
}

process.exitCode = await main();
