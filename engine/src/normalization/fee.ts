/**
 * The fee, read out of the transaction itself.
 *
 * `getFeeForMessage` is the authority when it answers, because the runtime
 * computes it. It does not always answer: it needs a valid blockhash, so any
 * historical transaction comes back with nothing. And the fee is the one
 * amount no manifest bounds -- the diff takes it out of the payer's balance
 * change on purpose -- so having no number for it means an arbitrary priority
 * fee is SOL leaving the wallet that nothing at all looks at.
 *
 * The declared fee is computable from the bytes, and there is something better
 * about it than the total charged: a priority fee is a DECLARATION. The
 * transaction states, in a ComputeBudget instruction, how much it is willing
 * to pay per compute unit. That is intent, which is the thing this whole
 * project compares against.
 *
 * Everything here is pure: a message in, numbers out, no network.
 */
import { z } from "zod";
import { addressAt, type ResolvedAccount } from "./accounts.js";

export const COMPUTE_BUDGET_PROGRAM_ID =
  "ComputeBudget111111111111111111111111111111";

/**
 * Signature-verification precompiles, which are charged per signature they
 * verify -- on top of the transaction's own required signatures.
 *
 * Found the same way as everything else here: one disagreement in 349 real
 * transactions, off by exactly 5000, which is one signature. The first byte
 * of the instruction data is how many signatures it carries.
 */
const PRECOMPILE_PROGRAM_IDS: ReadonlySet<string> = new Set([
  "Ed25519SigVerify111111111111111111111111111",
  "KeccakSecp256k11111111111111111111111111111",
  "Secp256r1SigVerify1111111111111111111111111",
]);

/**
 * Lamports per signature.
 *
 * A cluster parameter in principle, 5000 in practice for the whole life of the
 * network. It is an ASSUMPTION, which is why `getFeeForMessage` is preferred
 * whenever it answers -- the runtime knows the real value and this does not.
 */
const LAMPORTS_PER_SIGNATURE = 5_000n;

const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;

/** ComputeBudget instruction discriminators, first byte of the data. */
const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;

/**
 * A version 1 message does not use ComputeBudget instructions at all.
 *
 * It carries the same settings in the message itself, and `priorityFee` there
 * is already in LAMPORTS -- not micro-lamports per compute unit. Found by
 * comparing against what the network actually charged: every disagreement in
 * the first real-traffic run was a v1 transaction being read with v0 rules,
 * which produced a confident 5000 against a real 5026.
 *
 * Validated rather than trusted, because it is a runtime shape this project
 * narrows instead of casting.
 */
const transactionConfigSchema = z.object({
  priorityFee: z.union([z.number(), z.bigint(), z.null()]).optional(),
  computeUnitLimit: z.union([z.number(), z.null()]).optional(),
});

/**
 * The parts of a message this module reads.
 *
 * Structural on purpose, and narrower than `VersionedMessage`: a function that
 * asks for less is a function whose dependencies are visible, and it can be
 * tested with a literal instead of a compiled transaction.
 */
export interface FeeRelevantMessage {
  readonly version: "legacy" | number;
  readonly header: { readonly numRequiredSignatures: number };
  readonly compiledInstructions: readonly {
    readonly programIdIndex: number;
    readonly data: Uint8Array;
  }[];
}

export interface DeclaredFee {
  /** Signatures times the per-signature rate. */
  readonly base: bigint;
  /** Micro-lamports per compute unit, when the transaction sets a price. */
  readonly microLamportsPerUnit: bigint | null;
  /** Compute units requested, when the transaction sets a limit. */
  readonly computeUnitLimit: number | null;
  /**
   * The priority fee in lamports, when both parts are declared.
   *
   * null means the transaction set a price without a limit, so the runtime
   * applies a default this module deliberately does not guess at: guessing
   * high would over-subtract from the payer's balance change and HIDE value
   * leaving, which is the one error direction that must never happen.
   */
  readonly priority: bigint | null;
  /** base + priority, or null when the priority part is unknown. */
  readonly total: bigint | null;
}

/**
 * Reads the fee the transaction declares.
 *
 * `accounts` is needed because an instruction names its program by index, and
 * with a lookup table that index may not be in the message's static keys.
 */
export function declaredFeeOf(
  message: FeeRelevantMessage,
  accounts: readonly ResolvedAccount[],
): DeclaredFee {
  // Signatures the transaction requires, plus any a precompile verifies.
  let signatures = BigInt(message.header.numRequiredSignatures);
  for (const instruction of message.compiledInstructions) {
    const program = addressAt(accounts, instruction.programIdIndex);
    if (program === null || !PRECOMPILE_PROGRAM_IDS.has(program)) continue;
    const data = Buffer.from(instruction.data);
    if (data.length > 0) signatures += BigInt(data.readUInt8(0));
  }
  const base = signatures * LAMPORTS_PER_SIGNATURE;

  const unknown: DeclaredFee = {
    base,
    microLamportsPerUnit: null,
    computeUnitLimit: null,
    priority: null,
    total: null,
  };

  // Version 1 carries its own config, in lamports.
  if ("transactionConfig" in message) {
    const parsed = transactionConfigSchema.safeParse(message.transactionConfig);
    // A shape we do not recognise means we do not know the fee. Saying so is
    // the point: a confident wrong number here would under-report a priority
    // fee, and the fee is the one amount no manifest bounds.
    if (!parsed.success) return unknown;
    const declared = parsed.data.priorityFee;
    const priority = declared === undefined || declared === null ? 0n : BigInt(declared);
    return {
      base,
      microLamportsPerUnit: null,
      computeUnitLimit: parsed.data.computeUnitLimit ?? null,
      priority,
      total: base + priority,
    };
  }

  // A version this code has never seen prices itself in some way nobody here
  // knows. Better to have no number than a wrong one.
  if (message.version !== "legacy" && message.version !== 0) return unknown;

  let microLamportsPerUnit: bigint | null = null;
  let computeUnitLimit: number | null = null;

  for (const instruction of message.compiledInstructions) {
    if (
      addressAt(accounts, instruction.programIdIndex) !==
      COMPUTE_BUDGET_PROGRAM_ID
    )
      continue;
    const data = Buffer.from(instruction.data);
    if (data.length === 0) continue;
    const discriminator = data.readUInt8(0);
    // A short instruction is malformed and is skipped rather than read past
    // the end of the buffer. The transaction would fail anyway.
    if (discriminator === SET_COMPUTE_UNIT_PRICE && data.length >= 9) {
      microLamportsPerUnit = data.readBigUInt64LE(1);
    } else if (discriminator === SET_COMPUTE_UNIT_LIMIT && data.length >= 5) {
      computeUnitLimit = data.readUInt32LE(1);
    }
  }

  if (microLamportsPerUnit === null) {
    // No price set means no priority fee at all, which is exact.
    return {
      base,
      microLamportsPerUnit: null,
      computeUnitLimit,
      priority: 0n,
      total: base,
    };
  }
  if (computeUnitLimit === null) {
    return { ...unknown, microLamportsPerUnit };
  }

  // Rounded UP, the way the runtime charges it.
  const product = microLamportsPerUnit * BigInt(computeUnitLimit);
  const priority =
    (product + MICRO_LAMPORTS_PER_LAMPORT - 1n) / MICRO_LAMPORTS_PER_LAMPORT;
  return {
    base,
    microLamportsPerUnit,
    computeUnitLimit,
    priority,
    total: base + priority,
  };
}
