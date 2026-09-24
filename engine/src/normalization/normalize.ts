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
import type { AccountState, InnerInstructionRef, RpcClient } from "./rpc.js";

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

export interface NormalizeOptions {
  /** Network fee in lamports, when the caller already knows it. */
  readonly fee?: bigint | null;
  /**
   * How many times to retry for slot alignment. Each attempt is two more RPC
   * calls; 1 disables retrying.
   */
  readonly alignmentAttempts?: number;
}

function unavailable(reason: string, coverage: AccountCoverage): EffectSet {
  return {
    effects: [],
    slot: null,
    baselineSlot: null,
    fee: null,
    simulation: { status: "unavailable", reason },
    coverage,
  };
}

const NO_COVERAGE: AccountCoverage = {
  referenced: [],
  observed: [],
  unobserved: [],
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
  const fee = options.fee ?? null;

  // 1. Which accounts does this transaction touch?
  const resolved = await resolveAccounts(tx.message, rpc);
  if (!resolved.ok) {
    return unavailable(
      `could not resolve accounts: ${resolved.failure.message}`,
      NO_COVERAGE,
    );
  }
  const { accounts, toObserve, unresolvedTables } = resolved.value;
  const referenced = accounts.map((a) => a.address);

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
  let before: Awaited<ReturnType<RpcClient["readAccounts"]>> | null = null;
  let simulated: Awaited<ReturnType<RpcClient["simulate"]>> | null = null;

  const attempts = Math.max(
    1,
    options.alignmentAttempts ?? DEFAULT_ALIGNMENT_ATTEMPTS,
  );
  for (let attempt = 0; attempt < attempts; attempt++) {
    const [read, run] = await Promise.all([
      rpc.readAccounts(toObserve),
      rpc.simulate(tx, { accounts: toObserve, innerInstructions: true }),
    ]);
    before = read;
    simulated = run;
    if (!read.ok || !run.ok) break;
    if (read.value.slot === run.value.slot) break;
  }

  if (before === null || !before.ok) {
    const reason =
      before === null ? "no attempt was made" : before.failure.message;
    return unavailable(`could not read account state: ${reason}`, {
      referenced,
      observed: [],
      unobserved: [...referenced, ...blind],
    });
  }
  if (simulated === null || !simulated.ok) {
    const reason =
      simulated === null ? "no attempt was made" : simulated.failure.message;
    return unavailable(`could not simulate: ${reason}`, {
      referenced,
      observed: [],
      unobserved: [...referenced, ...blind],
    });
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
  const unobserved = [
    ...referenced.filter((address) => !observed.includes(address)),
    ...blind,
  ];
  const coverage: AccountCoverage = { referenced, observed, unobserved };

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
      simulation: outcome,
      coverage: {
        referenced,
        observed: [],
        unobserved: [...referenced, ...blind],
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
    feePayer: accounts[0]?.address ?? "",
    fee,
    invokedPrograms: [...new Set(programs)],
  });

  return {
    effects,
    slot: simulated.value.slot,
    baselineSlot: before.value.slot,
    fee,
    simulation: {
      status: "executed",
      unitsConsumed: simulated.value.unitsConsumed,
    },
    coverage,
  };
}
