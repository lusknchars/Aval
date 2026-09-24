/**
 * The effect vocabulary: the core of VETO.
 *
 * Everything a transaction does is expressed in these types, and everything a
 * tool manifest expects is expressed in the same ones. That makes "what the
 * transaction did" and "what the tool is allowed to do" two sets of the same
 * type, so comparing them is a set operation -- not an interpretation.
 *
 * CLOSED on purpose. Do not add a type without an explicit decision: every new
 * type is a new rule in every manifest already written.
 *
 * PROGRAM-AGNOSTIC on purpose. The types derive from the account model, not
 * from instructions. A program never seen before, if it grants a delegate,
 * produces DELEGATE_GRANT all the same.
 */
import { z } from "zod";

/**
 * Single source for the 8 types. The schema exists because manifests are
 * hand-written and must be validated at runtime; the TypeScript type derives
 * from it so there are never two lists able to drift apart.
 */
export const effectTypeSchema = z.enum([
  "BALANCE_DECREASE", // account lost value
  "BALANCE_INCREASE", // account gained value
  "DELEGATE_GRANT", // spending authority granted to a third party
  "AUTHORITY_CHANGE", // mint / freeze / upgrade / close authority changed
  "OWNER_CHANGE", // account owner changed
  "ACCOUNT_CREATE",
  "ACCOUNT_CLOSE",
  "PROGRAM_INVOKE", // program called, including through CPI
]);

export type EffectType = z.infer<typeof effectTypeSchema>;

/** The 8 types in declaration order. Derived from the schema, never duplicated. */
export const EFFECT_TYPES: readonly EffectType[] = effectTypeSchema.options;

/** Which authority changed, when the effect is AUTHORITY_CHANGE. */
export const authorityKindSchema = z.enum([
  "mint",
  "freeze",
  "upgrade",
  "close",
]);
export type AuthorityKind = z.infer<typeof authorityKindSchema>;

/**
 * An effect observed in the simulation.
 *
 * Optional fields are optional because not every effect type has them:
 * PROGRAM_INVOKE has no `mint`, BALANCE_INCREASE has no authority. Which
 * combination is valid per type belongs to whoever builds effects (the
 * normalizer) and whoever compares them (the evaluation layer), not here.
 *
 * `amount` is always bigint. A token amount is never a number: lamports and
 * raw SPL amounts are u64, and number loses precision above 2^53-1.
 */
export interface Effect {
  readonly type: EffectType;

  /** Affected account, base58. */
  readonly account: string;

  /** Token mint, or "SOL" for the native asset. */
  readonly mint?: string;

  /** Magnitude in raw units (lamports for SOL, smallest unit for SPL). */
  readonly amount?: bigint;

  /** Who receives value or authority, base58. */
  readonly counterparty?: string;

  /**
   * The wallet that controls the account, when the account is a token
   * account, base58.
   *
   * Deliberately NOT `counterparty`. A counterparty is a party that receives,
   * and the provenance check exists to ask where it came from; the owner of an
   * account that LOSES value receives nothing, and filing it as a counterparty
   * would ask the captured context to explain the victim.
   *
   * It is here so the scope check can tell whose account was touched. A token
   * account address appears in no prompt and on no page -- the wallet behind
   * it does.
   */
  readonly owner?: string;

  /** Program involved, base58. */
  readonly program?: string;

  /** AUTHORITY_CHANGE only: which authority changed. */
  readonly authorityKind?: AuthorityKind;
}

// ---------------------------------------------------------------- EffectSet

/**
 * The outcome of trying to simulate. It is a RESULT, never a swallowed
 * exception: the difference between "it ran and the transaction would fail"
 * and "I could not simulate" changes the decision. A discriminated union
 * forces every consumer to handle all three cases.
 */
export type SimulationOutcome =
  | { readonly status: "executed"; readonly unitsConsumed: number | null }
  | {
      readonly status: "failed";
      readonly error: string;
      readonly unitsConsumed: number | null;
    }
  | { readonly status: "unavailable"; readonly reason: string };

/**
 * Which accounts VETO was actually able to observe.
 *
 * `simulateTransaction` with the `accounts` option returns ONLY the addresses
 * asked for -- the RPC performs no discovery. If the normalizer does not ask
 * for an account the transaction touches, there is a blind spot. A blind spot
 * becomes a finding, never silence: this is "degrade, never open" as a type.
 */
export interface AccountCoverage {
  /** Every account referenced by the message, with lookup tables resolved. */
  readonly referenced: readonly string[];
  /** Accounts with state before AND after, from which effects could be derived. */
  readonly observed: readonly string[];
  /**
   * Referenced but never observed. Mostly readonly accounts, which cannot
   * change state -- expected, and not worth an alert on its own.
   */
  readonly unobserved: readonly string[];
  /**
   * Accounts the transaction touches whose address could not even be
   * resolved, because a lookup table could not be read.
   *
   * Separate from `unobserved` on purpose. Not observing a readonly account
   * is normal; not knowing an address exists at all is a real blind spot, and
   * conflating the two would make every ordinary transaction raise a flag --
   * which is how a customer learns to ignore the alert.
   */
  readonly blindSpots: readonly string[];
  /**
   * Observed accounts carrying Token-2022 extension bytes VETO does not
   * decode.
   *
   * Separate from a blind spot: the account WAS read and its base layout is
   * correct. What is unread is everything the extensions add -- a transfer
   * hook, a permanent delegate, a confidential balance -- and none of those
   * would show up as an effect.
   */
  readonly tokenExtensions: readonly string[];
}

/**
 * The factual basis of the evaluation: what the transaction would do, in the
 * closed vocabulary.
 *
 * A flat list on purpose. Comparison against a manifest is a set operation,
 * and a set needs elements of the same type. Category views (counterparties,
 * programs, effects of one type) are derived by the functions below, never
 * duplicated fields that could drift from the list.
 */
export interface EffectSet {
  readonly effects: readonly Effect[];
  /** Slot the simulation was evaluated against. null when unavailable. */
  readonly slot: number | null;
  /**
   * Slot the BEFORE state was read at. null when it could not be read.
   *
   * When this differs from `slot`, the two sides of the diff come from
   * different moments, and anything that changed the account in between is
   * attributed to this transaction. There is no way to read state and simulate
   * atomically over public RPC, so the gap is declared instead of hidden. An
   * account with heavy concurrent traffic makes it visible immediately.
   */
  readonly baselineSlot: number | null;
  readonly simulation: SimulationOutcome;
  readonly coverage: AccountCoverage;
  /**
   * The network fee, in lamports, reported separately from the effects.
   *
   * The fee is a protocol cost, not something the user asked for. Folding it
   * into the fee payer's BALANCE_DECREASE would make every legitimate
   * transaction look like it moved slightly more value than the tool call
   * declared. Kept visible, just not conflated with intent. null when the fee
   * could not be estimated.
   */
  readonly fee: bigint | null;

  /**
   * The account that signs and pays, base58. null when it could not be
   * determined.
   *
   * Carried because the evaluation layer has to treat it as inside every
   * tool's account scope: every transaction charges its payer, so without
   * this the fee would be reported as an out-of-scope loss on every call.
   */
  readonly feePayer: string | null;
}

export function coverageIsComplete(coverage: AccountCoverage): boolean {
  return coverage.unobserved.length === 0;
}

export function effectsOfType(
  set: EffectSet,
  type: EffectType,
): readonly Effect[] {
  return set.effects.filter((e) => e.type === type);
}

/**
 * Who receives value or authority. This is the input of the provenance check.
 *
 * Two kinds of recipient, and missing the second one would leave the most
 * common attack unchecked:
 *
 * 1. Whoever a DELEGATE_GRANT, OWNER_CHANGE or AUTHORITY_CHANGE names.
 * 2. Whoever ends up with more value than they started with.
 *
 * An account that both gains and loses is the transaction moving value
 * through itself -- a fee payer, or a wrapped SOL account in a swap -- not a
 * party receiving anything. Those are left out.
 */
export function counterparties(set: EffectSet): readonly string[] {
  const seen = new Set<string>();
  const gained = new Set<string>();
  const spent = new Set<string>();

  for (const e of set.effects) {
    if (e.counterparty !== undefined) seen.add(e.counterparty);
    // An account that names a counterparty is the vessel, not the party. A
    // token account is derived from its owner's address, so reporting both
    // would ask the context to explain an address no human ever types -- and
    // would deny a transfer to a wallet the user named by its real name.
    if (e.type === "BALANCE_INCREASE" && e.counterparty === undefined)
      gained.add(e.account);
    if (e.type === "BALANCE_DECREASE") spent.add(e.account);
  }
  for (const account of gained) {
    if (!spent.has(account)) seen.add(account);
  }
  return [...seen];
}

/** Programs invoked, including through CPI. */
export function invokedPrograms(set: EffectSet): readonly string[] {
  const seen = new Set<string>();
  for (const e of set.effects) {
    if (e.program !== undefined) seen.add(e.program);
  }
  return [...seen];
}
