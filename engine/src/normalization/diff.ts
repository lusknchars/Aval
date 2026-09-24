/**
 * The diff: account state before and after the simulation, turned into the
 * closed effect vocabulary.
 *
 * This is the heart of the normalizer, and it is a pure function. Everything
 * that touches the network happened already; here there are only bytes and
 * comparisons, which is why it is testable against recorded fixtures.
 *
 * Three rules earned from real responses, each with a comment where it is
 * applied: wrapped SOL must not be counted twice, the network fee is not an
 * effect of intent, and an account that was never observed is never assumed
 * to be unchanged.
 */
import type { Effect } from "../types/effects.js";
import type { ResolvedAccount } from "./accounts.js";
import type { AccountState } from "./rpc.js";
import {
  decodeMint,
  decodeTokenAccount,
  isTokenProgram,
  MINT_SIZE,
  type TokenAccount,
} from "./spl.js";

/** The native asset, in the mint position. */
export const NATIVE_MINT_LABEL = "SOL";

export interface DiffInput {
  readonly accounts: readonly ResolvedAccount[];
  /** Observed addresses -> state before. A missing key means never observed. */
  readonly before: ReadonlyMap<string, AccountState | null>;
  readonly after: ReadonlyMap<string, AccountState | null>;
  readonly feePayer: string;
  /** Network fee in lamports, when known. Excluded from the fee payer's delta. */
  readonly fee: bigint | null;
  /** Programs invoked, outer instructions and CPIs already resolved. */
  readonly invokedPrograms: readonly string[];
}

function tokenAccountOf(state: AccountState): TokenAccount | null {
  if (!isTokenProgram(state.owner)) return null;
  const decoded = decodeTokenAccount(state.data, state.owner);
  return decoded.ok ? decoded.value : null;
}

function isMintAccount(state: AccountState): boolean {
  return isTokenProgram(state.owner) && state.data.length === MINT_SIZE;
}

function balanceEffect(
  account: string,
  mint: string,
  delta: bigint,
): Effect | null {
  if (delta === 0n) return null;
  return delta > 0n
    ? { type: "BALANCE_INCREASE", account, mint, amount: delta }
    : { type: "BALANCE_DECREASE", account, mint, amount: -delta };
}

/**
 * SOL movement for one account.
 *
 * A token account is skipped on purpose. For wrapped SOL the lamport balance
 * and the token amount are the same value seen twice -- emitting both would
 * report a single movement as two, and a manifest checking magnitude would
 * see double what the tool call declared.
 */
function solEffects(
  address: string,
  before: AccountState,
  after: AccountState,
  feePayer: string,
  fee: bigint | null,
): readonly Effect[] {
  if (isTokenProgram(before.owner) || isTokenProgram(after.owner)) return [];

  let delta = after.lamports - before.lamports;
  // The fee payer always loses the fee. That is the cost of asking, not part
  // of what was asked for, so it comes out of the delta and is reported on
  // the EffectSet instead.
  if (address === feePayer && fee !== null && delta < 0n) delta += fee;

  const effect = balanceEffect(address, NATIVE_MINT_LABEL, delta);
  return effect === null ? [] : [effect];
}

/** Everything that can change inside a token account's 165 bytes. */
function tokenEffects(
  address: string,
  before: TokenAccount,
  after: TokenAccount,
): readonly Effect[] {
  const effects: Effect[] = [];

  const balance = balanceEffect(
    address,
    after.mint,
    after.amount - before.amount,
  );
  if (balance !== null) effects.push(balance);

  // Who controls the tokens changed: a SetAuthority(AccountOwner), which is
  // the quietest way to lose an account without any balance moving.
  if (before.owner !== after.owner) {
    effects.push({
      type: "OWNER_CHANGE",
      account: address,
      counterparty: after.owner,
    });
  }

  // A delegate that is new, different, or granted more room than before.
  const delegateAppeared =
    after.delegate !== null && after.delegate !== before.delegate;
  const allowanceGrew =
    after.delegate !== null && after.delegatedAmount > before.delegatedAmount;
  if (delegateAppeared || allowanceGrew) {
    effects.push({
      type: "DELEGATE_GRANT",
      account: address,
      counterparty: after.delegate ?? "",
      mint: after.mint,
      amount: after.delegatedAmount,
    });
  }

  if (
    before.closeAuthority !== after.closeAuthority &&
    after.closeAuthority !== null
  ) {
    effects.push({
      type: "AUTHORITY_CHANGE",
      account: address,
      authorityKind: "close",
      counterparty: after.closeAuthority,
    });
  }

  return effects;
}

function mintEffects(
  address: string,
  before: AccountState,
  after: AccountState,
): readonly Effect[] {
  const b = decodeMint(before.data, before.owner);
  const a = decodeMint(after.data, after.owner);
  if (!b.ok || !a.ok) return [];

  const effects: Effect[] = [];
  if (b.value.mintAuthority !== a.value.mintAuthority) {
    const effect: Effect = {
      type: "AUTHORITY_CHANGE",
      account: address,
      authorityKind: "mint",
      ...(a.value.mintAuthority === null
        ? {}
        : { counterparty: a.value.mintAuthority }),
    };
    effects.push(effect);
  }
  if (b.value.freezeAuthority !== a.value.freezeAuthority) {
    const effect: Effect = {
      type: "AUTHORITY_CHANGE",
      account: address,
      authorityKind: "freeze",
      ...(a.value.freezeAuthority === null
        ? {}
        : { counterparty: a.value.freezeAuthority }),
    };
    effects.push(effect);
  }
  return effects;
}

/** An account that did not exist and now does. */
function creationEffects(
  address: string,
  after: AccountState,
): readonly Effect[] {
  const effects: Effect[] = [{ type: "ACCOUNT_CREATE", account: address }];
  if (after.lamports > 0n && !isTokenProgram(after.owner)) {
    effects.push({
      type: "BALANCE_INCREASE",
      account: address,
      mint: NATIVE_MINT_LABEL,
      amount: after.lamports,
    });
  }
  const token = after.owner === "" ? null : tokenAccountOf(after);
  if (token !== null) {
    if (token.amount > 0n) {
      effects.push({
        type: "BALANCE_INCREASE",
        account: address,
        mint: token.mint,
        amount: token.amount,
      });
    }
    // A brand new account already carrying a delegate: the grant happened in
    // this very transaction, and there is no previous state to compare to.
    if (token.delegate !== null) {
      effects.push({
        type: "DELEGATE_GRANT",
        account: address,
        counterparty: token.delegate,
        mint: token.mint,
        amount: token.delegatedAmount,
      });
    }
  }
  return effects;
}

/**
 * Whether the post-state describes an account that no longer exists.
 *
 * A closed account does NOT come back as null. The runtime zeroes it and hands
 * it back owned by the System Program with no data and no lamports -- verified
 * against a devnet simulation that creates a token account and closes it. An
 * account with zero lamports is deleted when the transaction ends, so that is
 * the test, not the null.
 */
function isClosed(state: AccountState | null): boolean {
  return state !== null && state.lamports === 0n;
}

/** An account that existed and no longer does. Its lamports went somewhere. */
function closureEffects(
  address: string,
  before: AccountState,
): readonly Effect[] {
  const effects: Effect[] = [{ type: "ACCOUNT_CLOSE", account: address }];
  if (before.lamports > 0n) {
    effects.push({
      type: "BALANCE_DECREASE",
      account: address,
      mint: NATIVE_MINT_LABEL,
      amount: before.lamports,
    });
  }
  return effects;
}

/**
 * Turns observed state transitions into effects.
 *
 * Only observed accounts produce effects. An account that was never observed
 * produces nothing here and must be reported through coverage instead -- the
 * absence of an effect is never evidence that nothing happened.
 */
export function diffAccounts(input: DiffInput): readonly Effect[] {
  const effects: Effect[] = [];
  const seen = new Set<string>();

  for (const account of input.accounts) {
    const address = account.address;
    if (seen.has(address)) continue;
    seen.add(address);
    if (!input.before.has(address) && !input.after.has(address)) continue;

    const before = input.before.get(address) ?? null;
    const after = input.after.get(address) ?? null;

    if (before === null && after !== null) {
      // Created and closed inside the same transaction. Both happened, and a
      // manifest that forbids either one has to see it.
      if (isClosed(after)) {
        effects.push({ type: "ACCOUNT_CREATE", account: address });
        effects.push({ type: "ACCOUNT_CLOSE", account: address });
        continue;
      }
      effects.push(...creationEffects(address, after));
      continue;
    }
    if (before !== null && after === null) {
      effects.push(...closureEffects(address, before));
      continue;
    }
    if (before === null || after === null) continue;

    // The account existed and is gone. Reporting this as an owner change plus
    // a balance drop would hide the thing that actually matters.
    if (isClosed(after) && before.lamports > 0n) {
      effects.push(...closureEffects(address, before));
      continue;
    }

    if (before.owner !== after.owner) {
      effects.push({
        type: "OWNER_CHANGE",
        account: address,
        counterparty: after.owner,
      });
    }
    effects.push(
      ...solEffects(address, before, after, input.feePayer, input.fee),
    );

    const tokenBefore = tokenAccountOf(before);
    const tokenAfter = tokenAccountOf(after);
    if (tokenBefore !== null && tokenAfter !== null) {
      effects.push(...tokenEffects(address, tokenBefore, tokenAfter));
    } else if (isMintAccount(before) && isMintAccount(after)) {
      effects.push(...mintEffects(address, before, after));
    }
  }

  for (const program of input.invokedPrograms) {
    effects.push({ type: "PROGRAM_INVOKE", account: program, program });
  }

  return effects;
}
