/**
 * The normalizer: an unsigned transaction in, an EffectSet out.
 *
 * This is the only place that orchestrates the four steps, and the only place
 * that decides what happens when one of them fails. That decision is always
 * the same: degrade explicitly. A step that could not run produces an
 * `unavailable` outcome with a reason, never an empty effect list -- an empty
 * list means "this transaction does nothing", which would read as approval.
 */
import type { VersionedTransaction } from "@solana/web3.js";
import type {
  AccountCoverage,
  Effect,
  EffectSet,
  SimulationOutcome,
} from "../types/effects.js";
import {
  addressAt,
  invokedProgramsOf,
  resolveAccounts,
  type ResolvedAccount,
} from "./accounts.js";
import { diffAccounts } from "./diff.js";
import { declaredFeeOf } from "./fee.js";
import { messageBytes, messageDigestOf } from "./message.js";
import { MAX_SIMULATION_ACCOUNTS, withDeadline } from "./rpc.js";
import type { AccountState, InnerInstructionRef, RpcClient } from "./rpc.js";
import {
  authorityBearingProgram,
  decodeTokenAccount,
  extendedAccountType,
  isTokenProgram,
  MINT_SIZE,
  opaqueExtensionsOf,
} from "./spl.js";

/**
 * Default number of attempts at landing the read and the simulation on the
 * same slot. Slots are roughly 400ms and a round trip is shorter than that,
 * so a couple of attempts usually suffice.
 *
 * Each attempt costs two RPC calls, so this multiplies request volume. Under
 * a rate limit that trade goes the wrong way: measured over 60 mainnet
 * transactions, three attempts produced enough 429s to make alignment WORSE
 * than one attempt. Callers doing bulk work should lower it.
 */
const DEFAULT_ALIGNMENT_ATTEMPTS = 3;

/**
 * Total time the whole normalization may take, in milliseconds.
 *
 * The client has deadlines of its own, and this is not a duplicate of them:
 * an `RpcClient` is an interface, and an integrator's implementation may have
 * none. Whoever promises an answer owns the deadline, so the orchestrator
 * holds a budget of its own and spends it across every step.
 *
 * Running out degrades to `unavailable`, which is a critical coverage finding
 * and therefore a deny. A decision that never arrives is the one outcome
 * worse than a wrong one: the agent is left holding an unsigned transaction
 * and no answer at all.
 */
export const DEFAULT_TOTAL_DEADLINE_MS = 5_000;

export interface NormalizeOptions {
  /** Total budget for every network step together. */
  readonly deadlineMs?: number;
  /** Network fee in lamports, when the caller already knows it. */
  readonly fee?: bigint | null;
  /**
   * How many times to retry for slot alignment. Each attempt is two more RPC
   * calls; 1 disables retrying.
   */
  readonly alignmentAttempts?: number;
  /**
   * The transaction's original wire bytes, base64. Required for a version 1
   * transaction, which the SDK can read but cannot re-serialize.
   */
  readonly rawTransactionBase64?: string;
}

function unavailable(
  reason: string,
  coverage: AccountCoverage,
  feePayer: string | null = null,
  messageDigest: string | null = null,
): EffectSet {
  return {
    effects: [],
    slot: null,
    baselineSlot: null,
    fee: null,
    feePayer,
    messageDigest,
    simulation: { status: "unavailable", reason },
    coverage,
  };
}

const NO_COVERAGE: AccountCoverage = {
  referenced: [],
  observed: [],
  unobserved: [],
  blindSpots: [],
  tokenExtensions: [],
  opaqueChanges: [],
  inexactAmounts: [],
  undecodable: [],
  overSimulationLimit: [],
};

/** Programs called through CPI, with index-shaped references resolved. */
function innerPrograms(
  inner: readonly InnerInstructionRef[] | null,
  accounts: readonly ResolvedAccount[],
): readonly string[] {
  if (inner === null) return [];
  const programs: string[] = [];
  for (const ref of inner) {
    const address =
      ref.program ??
      (ref.programIndex === null
        ? null
        : addressAt(accounts, ref.programIndex));
    if (address !== null) programs.push(address);
  }
  return programs;
}

export async function normalize(
  tx: VersionedTransaction,
  rpc: RpcClient,
  options: NormalizeOptions = {},
): Promise<EffectSet> {
  const declaredFee = options.fee ?? null;
  const signable = messageBytes(tx, options.rawTransactionBase64);
  const messageDigest = messageDigestOf(tx, options.rawTransactionBase64);

  const startedAt = Date.now();
  const budget = options.deadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS;
  /** What is left of the budget. Never zero, so a step always gets a chance. */
  const remaining = (): number => Math.max(1, budget - (Date.now() - startedAt));

  // 1. Which accounts does this transaction touch?
  const resolution = await withDeadline(
    resolveAccounts(tx.message, rpc),
    remaining(),
    "resolveAccounts",
  );
  if (!resolution.ok) {
    return unavailable(
      `could not resolve accounts: ${resolution.failure.message}`,
      NO_COVERAGE,
      null,
      messageDigest,
    );
  }
  const resolved = resolution.value;
  if (!resolved.ok) {
    return unavailable(
      `could not resolve accounts: ${resolved.failure.message}`,
      NO_COVERAGE,
      null,
      messageDigest,
    );
  }
  const { accounts, unresolvedTables } = resolved.value;
  // The simulation returns post-state for a limited number of addresses. The
  // first ones in message order are the signers and the fee payer, so cutting
  // from the end never drops the caller's own accounts -- and naming what was
  // cut is what keeps this from being a silent blind spot.
  const toObserve = resolved.value.toObserve.slice(0, MAX_SIMULATION_ACCOUNTS);
  const overLimit = resolved.value.toObserve.slice(MAX_SIMULATION_ACCOUNTS);
  const referenced = accounts.map((a) => a.address);
  // First account of the message, by the wire format: the signer who pays.
  const feePayer = accounts[0]?.address ?? null;

  // An account behind an unreadable lookup table is referenced but has no
  // address, so it can never be observed. Named here, not swallowed.
  const blind = unresolvedTables.map((u) => `${u.table}: ${u.reason}`);

  // 2 and 3. The two sides of the diff, taken as close together as possible.
  //
  // They are fired in parallel and their slots compared. State cannot be read
  // and simulated atomically over public RPC, so alignment is checked rather
  // than assumed: when the two land on different slots, anything that touched
  // an observed account in between would be attributed to this transaction.
  // A few attempts usually land on the same slot; when they do not, the gap is
  // reported instead of hidden.
  /**
   * The fee, preferred from the BYTES rather than from the RPC.
   *
   * Verified exact against what the network actually charged on 150 of 150
   * real mainnet transactions, and it costs no round trip -- which removes a
   * call from the critical path and works on a transaction whose blockhash
   * has expired, where `getFeeForMessage` refuses to answer at all.
   *
   * The one assumption is the per-signature rate. If the cluster ever changed
   * it, this reads LOW, which leaves part of the fee inside the payer's
   * balance change: a decrease that looks slightly larger than it is. That is
   * a false positive, never a missed drain -- the only error direction
   * acceptable here.
   */
  const fromBytes = declaredFeeOf(tx.message, accounts).total;
  let fee: bigint | null = declaredFee ?? fromBytes;
  let before: Awaited<ReturnType<RpcClient["readAccounts"]>> | null = null;
  let simulated: Awaited<ReturnType<RpcClient["simulate"]>> | null = null;

  const attempts = Math.max(
    1,
    options.alignmentAttempts ?? DEFAULT_ALIGNMENT_ATTEMPTS,
  );
  for (let attempt = 0; attempt < attempts; attempt++) {
    const round = await withDeadline(
      Promise.all([
        rpc.readAccounts(toObserve),
        rpc.simulate(tx, {
          accounts: toObserve,
          innerInstructions: true,
          ...(options.rawTransactionBase64 === undefined
            ? {}
            : { rawTransactionBase64: options.rawTransactionBase64 }),
        }),
        // Only when the bytes could not be read -- a transaction version
        // whose fee model this code does not know. Then it is worth a round
        // trip, in parallel so it costs no extra latency.
        fee === null
          ? rpc.feeFor(
              tx,
              ...(signable === null ? [] : [signable.toString("base64")]),
            )
          : Promise.resolve({ ok: true, value: fee }),
      ]),
      remaining(),
      "read and simulate",
    );
    if (!round.ok) {
      // Out of budget. Stop retrying: an alignment retry is an improvement,
      // and there is no time left to improve anything.
      before = { ok: false, failure: round.failure };
      simulated = { ok: false, failure: round.failure };
      break;
    }
    const [read, run, charged] = round.value;
    before = read;
    simulated = run;
    if (fee === null) fee = charged.ok ? charged.value : null;
    if (!read.ok || !run.ok) break;
    if (read.value.slot === run.value.slot) break;
  }

  if (before === null || !before.ok) {
    const reason =
      before === null ? "no attempt was made" : before.failure.message;
    return unavailable(
      `could not read account state: ${reason}`,
      {
        referenced,
        observed: [],
        unobserved: toObserve,
        blindSpots: blind,
        tokenExtensions: [],
        opaqueChanges: [],
        inexactAmounts: [],
        undecodable: [],
        overSimulationLimit: overLimit,
      },
      feePayer,
      messageDigest,
    );
  }
  if (simulated === null || !simulated.ok) {
    const reason =
      simulated === null ? "no attempt was made" : simulated.failure.message;
    return unavailable(
      `could not simulate: ${reason}`,
      {
        referenced,
        observed: [],
        unobserved: toObserve,
        blindSpots: blind,
        tokenExtensions: [],
        opaqueChanges: [],
        inexactAmounts: [],
        undecodable: [],
        overSimulationLimit: overLimit,
      },
      feePayer,
      messageDigest,
    );
  }

  // The client is an INTERFACE, and an integrator's implementation may answer
  // with fewer post-states than were asked for. Zipping by position would
  // attribute one account's state to another, and a missing entry would read
  // as a closure. Same reasoning as the deadline: the orchestrator does not
  // take the client's word for it.
  if (
    simulated.value.error === null &&
    simulated.value.accounts.length !==
      simulated.value.requestedAccounts.length
  ) {
    return unavailable(
      `post-state covers ${simulated.value.accounts.length} of ${simulated.value.requestedAccounts.length} accounts`,
      {
        referenced,
        observed: [],
        unobserved: toObserve,
        blindSpots: blind,
        tokenExtensions: [],
        opaqueChanges: [],
        inexactAmounts: [],
        undecodable: [],
        overSimulationLimit: overLimit,
      },
      feePayer,
      messageDigest,
    );
  }

  const beforeByAddress = new Map<string, AccountState | null>(
    toObserve.map((address, i) => [address, before.value.accounts[i] ?? null]),
  );
  const afterByAddress = new Map<string, AccountState | null>(
    simulated.value.requestedAccounts.map((address, i) => [
      address,
      simulated.value.accounts[i] ?? null,
    ]),
  );

  // Observed means state on BOTH sides. A missing post-state is the normal
  // shape of a failed simulation, and it makes the account unobservable.
  const observed = toObserve.filter(
    (address) => beforeByAddress.has(address) && afterByAddress.has(address),
  );
  // A GAP, not an inventory.
  //
  // This used to be every referenced account minus the observed ones, which
  // always includes the readonly accounts -- and a readonly account cannot
  // change state, so never observing one is not a gap, it is the design. The
  // effect was a finding on literally every transaction, which is the precise
  // definition of a check nobody reads. What belongs here is an account we
  // ASKED about and did not get back.
  const unobserved = toObserve.filter(
    (address) => !observed.includes(address),
  );
  // Read off the post-state: an account whose base layout decoded fine but
  // which carries Token-2022 extensions VETO cannot see through. Same shape
  // as blindSpots -- what, and on which account.
  const tokenExtensions: string[] = [];
  // And the other half of the same question: an account whose bytes changed
  // that the diff produced nothing for, because nothing here decodes it.
  const opaqueChanges: string[] = [];
  // And the value that was already rounded before it reached us.
  const inexactAmounts: string[] = [];
  // And an account a token program owns whose bytes we could not read at all.
  const undecodable: string[] = [];
  for (const address of observed) {
    const after = afterByAddress.get(address);
    const before = beforeByAddress.get(address);
    if (after === undefined || after === null) continue;
    if (after.lamportsExact === false || before?.lamportsExact === false)
      inexactAmounts.push(address);
    const opaque = opaqueExtensionsOf(after.owner, after.data);
    if (opaque.length > 0)
      tokenExtensions.push(`${address}: ${opaque.join(", ")}`);

    // A token-program account that is neither a readable account nor a mint.
    // The diff will produce nothing for it, and nothing is precisely what a
    // drain hidden in unreadable bytes would look like.
    if (
      isTokenProgram(after.owner) &&
      after.data.length !== MINT_SIZE &&
      extendedAccountType(after.data) !== "mint"
    ) {
      const decoded = decodeTokenAccount(after.data, after.owner);
      if (!decoded.ok) undecodable.push(`${address}: ${decoded.reason}`);
    }

    const program = authorityBearingProgram(after.owner);
    if (
      program !== null &&
      before !== undefined &&
      before !== null &&
      !before.data.equals(after.data)
    ) {
      opaqueChanges.push(`${address}: ${program}`);
    }
  }

  const coverage: AccountCoverage = {
    referenced,
    observed,
    unobserved,
    blindSpots: blind,
    tokenExtensions,
    opaqueChanges,
    overSimulationLimit: overLimit,
    inexactAmounts,
    undecodable,
  };

  // 4. The transaction ran and would fail. There is no post-state to diff --
  // the RPC returns nulls -- so the outcome is reported, not guessed at.
  if (simulated.value.error !== null) {
    const outcome: SimulationOutcome = {
      status: "failed",
      error: simulated.value.error,
      unitsConsumed: simulated.value.unitsConsumed,
    };
    // Nothing was observed: a failed run has no post-state at all. Reporting
    // these accounts as observed would tell the evaluation layer it has
    // visibility it does not have.
    return {
      effects: [],
      slot: simulated.value.slot,
      baselineSlot: before.value.slot,
      fee,
      feePayer,
      messageDigest,
      simulation: outcome,
      coverage: {
        referenced,
        observed: [],
        unobserved: toObserve,
        blindSpots: blind,
        tokenExtensions: [],
        opaqueChanges: [],
        inexactAmounts: [],
        undecodable: [],
        overSimulationLimit: overLimit,
      },
    };
  }

  const programs = [
    ...invokedProgramsOf(tx.message, accounts),
    ...innerPrograms(simulated.value.innerInstructions, accounts),
  ];
  const effects: readonly Effect[] = diffAccounts({
    accounts,
    before: beforeByAddress,
    after: afterByAddress,
    feePayer: feePayer ?? "",
    fee,
    invokedPrograms: [...new Set(programs)],
  });

  return {
    effects,
    slot: simulated.value.slot,
    baselineSlot: before.value.slot,
    fee,
    feePayer,
    messageDigest,
    simulation: {
      status: "executed",
      unitsConsumed: simulated.value.unitsConsumed,
    },
    coverage,
  };
}
