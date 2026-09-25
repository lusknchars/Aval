/**
 * The fee is the one amount no manifest bounds.
 *
 * The diff takes it out of the payer's balance change on purpose -- it is the
 * cost of asking, not part of what was asked for -- so if the number is wrong
 * the error goes straight into an effect. Too HIGH is the dangerous direction:
 * over-subtracting hides value leaving the wallet.
 */
import { describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  type VersionedMessage,
} from "@solana/web3.js";
import {
  resolveAccounts,
  type ResolvedAccount,
} from "../../src/normalization/accounts.js";
import {
  declaredFeeOf,
  type FeeRelevantMessage,
} from "../../src/normalization/fee.js";
import type {
  AccountsRead,
  LookupTableRead,
  RpcClient,
  RpcResult,
  SimulationResponse,
} from "../../src/normalization/rpc.js";

const BLOCKHASH = PublicKey.default.toBase58();

const noNetwork: RpcClient = {
  readAccounts: async (): Promise<RpcResult<AccountsRead>> => ({
    ok: false,
    failure: { step: "readAccounts", message: "unused" },
  }),
  simulate: async (): Promise<RpcResult<SimulationResponse>> => ({
    ok: false,
    failure: { step: "simulate", message: "unused" },
  }),
  readLookupTables: async (): Promise<RpcResult<LookupTableRead>> => ({
    ok: true,
    value: { tables: [], unresolved: [] },
  }),
  feeFor: async (): Promise<RpcResult<bigint | null>> => ({
    ok: true,
    value: null,
  }),
  identifyNetwork: async (): Promise<RpcResult<string>> => ({
    ok: true,
    value: "test",
  }),
};

/**
 * A compiled message whose only signer is the payer, so the base fee is one
 * signature and the arithmetic under test is visible.
 */
async function messageWith(
  before: readonly TransactionInstruction[] = [],
): Promise<{
  message: VersionedMessage;
  accounts: readonly ResolvedAccount[];
}> {
  const payer = Keypair.generate().publicKey;
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: BLOCKHASH,
    instructions: [
      ...before,
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1n,
      }),
    ],
  }).compileToV0Message();
  const resolved = await resolveAccounts(message, noNetwork);
  if (!resolved.ok) throw new Error(resolved.failure.message);
  return { message, accounts: resolved.value.accounts };
}

describe("the fee a version 0 transaction declares", () => {
  it("is the base alone when no price is set", async () => {
    const { message, accounts } = await messageWith();
    const fee = declaredFeeOf(message, accounts);
    expect(fee.base).toBe(5_000n);
    expect(fee.priority).toBe(0n);
    expect(fee.total).toBe(5_000n);
  });

  it("adds the priority fee, rounded up the way the runtime charges it", async () => {
    // 1 micro-lamport per unit over 200_000 units is 0.2 lamports, and the
    // runtime charges 1. Rounding down here would under-report every small
    // priority fee.
    const { message, accounts } = await messageWith([
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ]);
    const fee = declaredFeeOf(message, accounts);
    expect(fee.priority).toBe(1n);
    expect(fee.total).toBe(5_001n);
  });

  it("computes a large priority fee without losing precision", async () => {
    const { message, accounts } = await messageWith([
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ]);
    // 50_000_000 * 1_400_000 / 1e6 = 70_000_000 lamports: 0.07 SOL of fee,
    // which is the shape of the drain the ceiling check exists for.
    expect(declaredFeeOf(message, accounts).priority).toBe(70_000_000n);
  });

  it("refuses to guess when a price is set with no limit", async () => {
    // The runtime applies a default. Guessing it high would over-subtract
    // from the payer's balance change and HIDE value leaving the wallet.
    const { message, accounts } = await messageWith([
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    ]);
    const fee = declaredFeeOf(message, accounts);
    expect(fee.microLamportsPerUnit).toBe(1_000n);
    expect(fee.priority).toBeNull();
    expect(fee.total).toBeNull();
  });
});

describe("signatures a precompile verifies", () => {
  it("counts them into the base fee", async () => {
    // Found in real traffic: one disagreement in 349, off by exactly 5000.
    // A signature-verification precompile is charged per signature it
    // carries, on top of the transaction's own required signatures, and the
    // count is the first byte of its data.
    const payer = Keypair.generate().publicKey;
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: BLOCKHASH,
      instructions: [
        new TransactionInstruction({
          programId: new PublicKey(
            "Ed25519SigVerify111111111111111111111111111",
          ),
          keys: [],
          data: Buffer.from([2, 0]),
        }),
        SystemProgram.transfer({
          fromPubkey: payer,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1n,
        }),
      ],
    }).compileToV0Message();
    const resolved = await resolveAccounts(message, noNetwork);
    if (!resolved.ok) throw new Error(resolved.failure.message);

    // One required signature plus the two the precompile verifies.
    expect(declaredFeeOf(message, resolved.value.accounts).base).toBe(15_000n);
  });
});

describe("a transaction version this code does not know", () => {
  it("reports no fee rather than a confident wrong one", async () => {
    // Found on real traffic: version 1 carries its settings in the message
    // instead of in ComputeBudget instructions, and reading it with version 0
    // rules produced a confident 5000 against a real 5026. A future version
    // must degrade, not invent.
    const { accounts } = await messageWith();
    const future: FeeRelevantMessage = {
      version: 9,
      header: { numRequiredSignatures: 1 },
      compiledInstructions: [],
    };
    expect(declaredFeeOf(future, accounts).total).toBeNull();
  });

  it("reads a version 1 fee from the message, in lamports", async () => {
    const { accounts } = await messageWith();
    // The shape the SDK hands back for a v1 message, observed on mainnet.
    // `priorityFee` there is already lamports, not micro-lamports per unit.
    const v1 = {
      version: 1,
      header: { numRequiredSignatures: 1 },
      compiledInstructions: [],
      transactionConfig: {
        computeUnitLimit: 115,
        heapSize: null,
        loadedAccountsDataSizeLimit: 585_000,
        priorityFee: 26,
      },
    };
    const fee = declaredFeeOf(v1, accounts);
    expect(fee.priority).toBe(26n);
    expect(fee.total).toBe(5_026n);
  });
});
