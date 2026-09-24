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

export interface NormalizeOptions {
  /** Network fee in lamports, when the caller already knows it. */
  readonly fee?: bigint | null;
}

function unavailable(reason: string, coverage: AccountCoverage): EffectSet {
  return {
    effects: [],
    slot: null,
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

  // 2. What do they look like now?
  const before = await rpc.readAccounts(toObserve);
  if (!before.ok) {
    return unavailable(
      `could not read account state: ${before.failure.message}`,
      {
        referenced,
        observed: [],
        unobserved: [...referenced, ...blind],
      },
    );
  }

  // 3. What would they look like if this ran?
  const simulated = await rpc.simulate(tx, {
    accounts: toObserve,
    minContextSlot: before.value.slot,
    innerInstructions: true,
  });
  if (!simulated.ok) {
    return unavailable(`could not simulate: ${simulated.failure.message}`, {
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
    fee,
    simulation: {
      status: "executed",
      unitsConsumed: simulated.value.unitsConsumed,
    },
    coverage,
  };
}
