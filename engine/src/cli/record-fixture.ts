/**
 * Records a fixture: builds a scenario on devnet, simulates it and saves the
 * raw response to test/fixtures/.
 *
 *   pnpm exec tsx --env-file=.env src/cli/record-fixture.ts <scenario>
 *   pnpm exec tsx --env-file=.env src/cli/record-fixture.ts --list
 *
 * Does NOT sign, does NOT send, does NOT persist a private key. The scenarios
 * use a public devnet account as fee payer and `sigVerify: false` in the
 * simulation -- the same technique as the exploration scripts.
 */
import { writeFile } from "node:fs/promises";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createApproveInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { recordAccount, type Fixture } from "../normalization/fixture.js";
import {
  GENESIS_BY_NETWORK,
  createRpcClient,
  readRpcConfig,
  type RpcClient,
} from "../normalization/rpc.js";
import { recentBlockhash } from "./blockhash.js";

/** Public devnet account with a balance, used as fee payer in every scenario. */
const FEE_PAYER = new PublicKey("11111111111111111111111111111112");
const U64_MAX = 18_446_744_073_709_551_615n;

interface Scenario {
  readonly name: string;
  readonly description: string;
  /** Builds the instructions and says which accounts must be observed. */
  build: () => { instructions: TransactionInstruction[]; observe: string[] };
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "transfer-sol",
    description:
      "SOL transfer that creates the destination account (rent-exempt)",
    build: () => {
      const destination = Keypair.generate().publicKey;
      return {
        instructions: [
          SystemProgram.transfer({
            fromPubkey: FEE_PAYER,
            toPubkey: destination,
            lamports: 1_000_000n,
          }),
        ],
        observe: [FEE_PAYER.toBase58(), destination.toBase58()],
      };
    },
  },
  {
    name: "create-ata",
    description:
      "Associated Token Account creation: CPIs into System and Token Program",
    build: () => {
      const owner = Keypair.generate().publicKey;
      const ata = getAssociatedTokenAddressSync(
        NATIVE_MINT,
        owner,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      return {
        instructions: [
          createAssociatedTokenAccountInstruction(
            FEE_PAYER,
            ata,
            owner,
            NATIVE_MINT,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          ),
        ],
        observe: [FEE_PAYER.toBase58(), ata.toBase58(), NATIVE_MINT.toBase58()],
      };
    },
  },
  {
    name: "unlimited-approve",
    description:
      "creates an ATA and grants a delegate with u64::MAX allowance -- the flagship signal",
    build: () => {
      const owner = Keypair.generate().publicKey;
      const delegate = Keypair.generate().publicKey;
      const ata = getAssociatedTokenAddressSync(
        NATIVE_MINT,
        owner,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      return {
        instructions: [
          createAssociatedTokenAccountInstruction(
            FEE_PAYER,
            ata,
            owner,
            NATIVE_MINT,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          ),
          // The owner would sign this. sigVerify: false lets us simulate anyway.
          createApproveInstruction(
            ata,
            delegate,
            owner,
            U64_MAX,
            [],
            TOKEN_PROGRAM_ID,
          ),
        ],
        observe: [FEE_PAYER.toBase58(), ata.toBase58(), delegate.toBase58()],
      };
    },
  },
];

async function record(
  scenario: Scenario,
  rpc: RpcClient,
  blockhash: string,
): Promise<Fixture> {
  const { instructions, observe } = scenario.build();

  const message = new TransactionMessage({
    payerKey: FEE_PAYER,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  // No .sign(): the signatures stay zeroed, and that is the point.
  const tx = new VersionedTransaction(message);

  const before = await rpc.readAccounts(observe);
  if (!before.ok)
    throw new Error(`before read failed: ${before.failure.message}`);

  const simulation = await rpc.simulate(tx, {
    accounts: observe,
    minContextSlot: before.value.slot,
    innerInstructions: true,
  });
  if (!simulation.ok)
    throw new Error(`simulation failed: ${simulation.failure.message}`);

  // Scenarios build messages without lookups, so this is normally empty. It
  // stays generic for when we record a mainnet transaction that uses ALTs.
  const referencedTables = message.addressTableLookups.map((l) =>
    l.accountKey.toBase58(),
  );
  const lookupTables: { table: string; addresses: string[] }[] = [];
  if (referencedTables.length > 0) {
    const read = await rpc.readLookupTables(referencedTables);
    if (!read.ok)
      throw new Error(`lookup table read failed: ${read.failure.message}`);
    for (const t of read.value.tables)
      lookupTables.push({ table: t.table, addresses: [...t.addresses] });
  }

  return {
    name: scenario.name,
    description: scenario.description,
    network: "devnet",
    recordedAt: new Date().toISOString(),
    genesis: GENESIS_BY_NETWORK.devnet,
    txBase64: Buffer.from(tx.serialize()).toString("base64"),
    before: {
      slot: before.value.slot,
      addresses: observe,
      accounts: before.value.accounts.map(recordAccount),
    },
    simulation: {
      slot: simulation.value.slot,
      error: simulation.value.error,
      unitsConsumed: simulation.value.unitsConsumed,
      logs: simulation.value.logs === null ? null : [...simulation.value.logs],
      requestedAccounts: [...simulation.value.requestedAccounts],
      accounts: simulation.value.accounts.map(recordAccount),
      innerInstructions:
        simulation.value.innerInstructions === null
          ? null
          : simulation.value.innerInstructions.map((i) => ({ ...i })),
    },
    lookupTables,
  };
}

async function main(): Promise<number> {
  const requested = process.argv[2];
  if (requested === undefined || requested === "--list") {
    console.log("available scenarios:");
    for (const s of SCENARIOS)
      console.log(`  ${s.name.padEnd(20)} ${s.description}`);
    return requested === undefined ? 1 : 0;
  }

  const config = readRpcConfig(process.env, "devnet");
  if (!config.ok) {
    console.error(config.failure.message);
    return 1;
  }
  const rpc = createRpcClient(config.value);

  const network = await rpc.identifyNetwork();
  if (!network.ok) {
    console.error(`RPC failure: ${network.failure.message}`);
    return 3;
  }
  if (network.value !== GENESIS_BY_NETWORK.devnet) {
    console.error(
      "VETO_RPC_URL_DEVNET answered, but it is not devnet. Refused.",
    );
    return 1;
  }

  const chosen =
    requested === "--all"
      ? SCENARIOS
      : SCENARIOS.filter((s) => s.name === requested);
  if (chosen.length === 0) {
    console.error(`unknown scenario: ${requested}. Use --list.`);
    return 1;
  }

  // replaceRecentBlockhash in the simulation covers this value expiring.
  const blockhash = await recentBlockhash(config.value);

  for (const scenario of chosen) {
    const fixture = await record(scenario, rpc, blockhash);
    const path = `test/fixtures/${scenario.name}.json`;
    await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    const outcome =
      fixture.simulation.error === null
        ? "error: null"
        : `error: ${fixture.simulation.error}`;
    console.log(
      `recorded ${path}  (slot ${fixture.simulation.slot}, ${outcome}, ${fixture.before.addresses.length} accounts)`,
    );
  }
  return 0;
}

process.exitCode = await main();
