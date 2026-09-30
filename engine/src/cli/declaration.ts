/**
 * The tool call a truthful agent would have made for a transaction.
 *
 * A real transaction carries no tool call, no user goal and no manifest, so it
 * cannot be evaluated as it stands. Reading the declaration back out of the
 * transaction's own effects is what lets a real one go through the
 * deterministic layer at all -- in bulk for measurement, and one at a time
 * when somebody wants to see a verdict for a specific signature.
 *
 * It is DELIBERATELY strict about giving up. A first version guessed loosely
 * -- any transaction that closed an account became `close_account` -- and the
 * findings that came out were correct readings of a wrong label: a
 * twenty-one-effect arbitrage bundle is not a close, and no manifest should be
 * asked to pretend it is. Every guess here has to be one a real agent could
 * have made.
 */
import { decodeMint } from "../normalization/spl.js";
import type { RpcClient } from "../normalization/rpc.js";
import type { Effect, EffectSet } from "../types/effects.js";

// ------------------------------------------------------------ classification

const SOL = "SOL";

function of(set: EffectSet, type: Effect["type"]): readonly Effect[] {
  return set.effects.filter((e) => e.type === type);
}

function largest(effects: readonly Effect[]): Effect | null {
  let best: Effect | null = null;
  for (const effect of effects) {
    const amount = effect.amount ?? 0n;
    if (best === null || amount > (best.amount ?? 0n)) best = effect;
  }
  return best;
}

const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";

export interface Declaration {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /** Mints whose decimals the manifest will need. */
  readonly mints: readonly string[];
}

/**
 * The tool call a truthful agent would have made for this transaction.
 *
 * Returns null when the transaction matches no primitive we have a manifest
 * for, and it is DELIBERATELY strict about that. A first version guessed
 * loosely -- any transaction that closed an account became `close_account` --
 * and the tally then filled with findings that were correct readings of a
 * wrong label: a twenty-one-effect arbitrage bundle is not a close, and no
 * manifest should be asked to pretend it is. Every guess here has to be one
 * a real agent could have made.
 *
 * Counting the misses separately matters too: a manifest set that covers a
 * tenth of real traffic is a different product from one that covers most.
 */
export function declarationFor(set: EffectSet): Declaration | null {
  const decreases = of(set, "BALANCE_DECREASE");
  const increases = of(set, "BALANCE_INCREASE");
  const tokenOut = decreases.filter((e) => e.mint !== SOL && e.mint !== undefined);
  const tokenIn = increases.filter((e) => e.mint !== SOL && e.mint !== undefined);
  const solOut = decreases.filter((e) => e.mint === SOL);
  const solIn = increases.filter((e) => e.mint === SOL);
  const grants = of(set, "DELEGATE_GRANT");
  const closes = of(set, "ACCOUNT_CLOSE");
  const authorities = of(set, "AUTHORITY_CHANGE");
  const owners = of(set, "OWNER_CHANGE");

  // Anything that hands over control is its own operation. A transaction
  // doing that AND moving value is not one of our primitives.
  if (authorities.length > 0 || owners.length > 0) return null;

  // Native staking is recognised by the stake program being called with
  // SOL arriving in, or leaving, one account -- and nothing else moving.
  const stakeProgram = of(set, "PROGRAM_INVOKE").some(
    (e) => e.program === STAKE_PROGRAM,
  );
  if (stakeProgram && tokenOut.length === 0 && tokenIn.length === 0 && grants.length === 0) {
    const creates = of(set, "ACCOUNT_CREATE");
    const out = largest(solOut);
    const into = largest(solIn);
    if (creates.length === 1 && out !== null && into !== null && closes.length === 0) {
      const created = creates[0];
      if (created !== undefined && into.account === created.account)
        return {
          tool: "stake_native",
          args: { from: out.account, stakeAccount: created.account, amount: out.amount ?? 0n },
          mints: [],
        };
    }
    if (out !== null && into !== null && solOut.length === 1 && solIn.length === 1 && creates.length === 0)
      return {
        tool: "withdraw_stake",
        args: { stakeAccount: out.account, to: into.account, amount: out.amount ?? 0n },
        mints: [],
      };
    if (solOut.length === 0 && solIn.length === 0 && creates.length === 0 && closes.length === 0) {
      // Deactivate: the program was called and no balance moved anywhere.
      return { tool: "unstake_native", args: { stakeAccount: "" }, mints: [] };
    }
  }

  if (grants.length > 0) {
    const grant = grants[0];
    if (grants.length > 1 || grant === undefined) return null;
    if (closes.length > 0 || tokenOut.length > 0) return null;
    return {
      tool: "approve",
      args: {
        account: grant.account,
        delegate: grant.counterparty ?? "",
        mint: grant.mint ?? "",
        amount: grant.amount ?? 0n,
      },
      mints: grant.mint === undefined ? [] : [grant.mint],
    };
  }

  if (closes.length > 0) {
    const closed = closes[0];
    // One close, and the rest of the transaction has to look like the rent
    // coming back. More than one close is a sweeper, and a sweeper is not
    // the primitive an agent calls.
    if (closes.length > 1 || closed === undefined) return null;
    if (tokenOut.length > 0 || tokenIn.length > 0) return null;
    if (solIn.length > 2) return null;
    const destination = largest(solIn);
    if (destination === null) return null;
    return {
      tool: "close_account",
      args: { account: closed.account, destination: destination.account },
      mints: [],
    };
  }

  const mintsMoved = new Set([...tokenOut, ...tokenIn].map((e) => e.mint ?? ""));
  const biggestTokenOut = largest(tokenOut);

  if (mintsMoved.size >= 2 && biggestTokenOut !== null) {
    const mint = biggestTokenOut.mint ?? "";
    const spender = biggestTokenOut.owner ?? biggestTokenOut.account;
    return {
      tool: "swap",
      args: {
        from: spender,
        to: set.feePayer ?? spender,
        mint,
        amountIn: biggestTokenOut.amount ?? 0n,
      },
      mints: [mint],
    };
  }

  if (biggestTokenOut !== null) {
    const mint = biggestTokenOut.mint ?? "";
    const received = tokenIn.find((e) => e.mint === mint);
    // A token leaving with nothing of the same mint arriving is not a
    // transfer: it is a burn, a deposit into a program, or a leg of
    // something bigger. None of those is a primitive we cover.
    if (received === undefined) return null;
    return {
      tool: "transfer_token",
      args: {
        from: biggestTokenOut.owner ?? biggestTokenOut.account,
        to: received.counterparty ?? received.account,
        mint,
        amount: biggestTokenOut.amount ?? 0n,
      },
      mints: [mint],
    };
  }

  const out = largest(solOut);
  const into = largest(solIn);
  // One account paying and one account receiving. More than that on either
  // side is a distribution or a sweep, not a transfer.
  if (out !== null && into !== null && solOut.length <= 2 && solIn.length <= 2) {
    return {
      tool: "transfer_sol",
      args: {
        from: out.account,
        to: into.account,
        amount: out.amount ?? 0n,
      },
      mints: [],
    };
  }

  return null;
}

/**
 * Decimals for the mints a declaration mentions.
 *
 * Needed because manifests declare token amounts in the unit the tool speaks.
 * Without them the amount cannot be converted and the check degrades -- which
 * would show up in the tally as our own instrumentation, not as a property of
 * the traffic.
 */
export async function decimalsFor(
  mints: readonly string[],
  rpc: RpcClient,
): Promise<ReadonlyMap<string, number>> {
  const found = new Map<string, number>();
  const wanted = mints.filter((m) => m !== "" && m !== SOL);
  if (wanted.length === 0) return found;
  const read = await rpc.readAccounts(wanted);
  if (!read.ok) return found;
  read.value.accounts.forEach((account, i) => {
    const address = wanted[i];
    if (account === null || address === undefined) return;
    const mint = decodeMint(account.data, account.owner);
    if (mint.ok) found.set(address, mint.value.decimals);
  });
  return found;
}

/**
 * Raw amounts turned into the decimal string a tool call would carry.
 *
 * A tool speaks "1.5 USDC", never "1500000". Passing the raw number would
 * make every honest declaration look a million times larger than it is.
 */
export function toDecimalArgs(
  declaration: Declaration,
  decimals: ReadonlyMap<string, number>,
  divideBy: bigint = 1n,
): Record<string, unknown> {
  const args = { ...declaration.args };
  for (const key of ["amount", "amountIn"]) {
    const raw = args[key];
    if (typeof raw !== "bigint") continue;
    const value = raw / divideBy;
    const mint = typeof args["mint"] === "string" ? args["mint"] : "";
    const places = decimals.get(mint);
    if (places === undefined) {
      args[key] = value.toString();
      continue;
    }
    const text = value.toString().padStart(places + 1, "0");
    const whole = text.slice(0, text.length - places);
    const fraction = places === 0 ? "" : `.${text.slice(text.length - places)}`;
    args[key] = `${whole}${fraction}`;
  }
  return args;
}
