import { describe, expect, it } from "vitest";
import {
  EFFECT_TYPES,
  authorityKindSchema,
  counterparties,
  coverageIsComplete,
  effectTypeSchema,
  effectsOfType,
  invokedPrograms,
  type AccountCoverage,
  type Effect,
  type EffectSet,
  type SimulationOutcome,
} from "../../src/types/effects.js";

describe("effect vocabulary", () => {
  it("has exactly the 8 agreed types", () => {
    // Deliberate lock: the vocabulary is closed. If this test fails, someone
    // changed it -- which requires an explicit decision, not a commit.
    expect(EFFECT_TYPES).toEqual([
      "BALANCE_DECREASE",
      "BALANCE_INCREASE",
      "DELEGATE_GRANT",
      "AUTHORITY_CHANGE",
      "OWNER_CHANGE",
      "ACCOUNT_CREATE",
      "ACCOUNT_CLOSE",
      "PROGRAM_INVOKE",
    ]);
    expect(EFFECT_TYPES).toHaveLength(8);
    expect(new Set(EFFECT_TYPES).size).toBe(8);
  });

  it("accepts vocabulary types and rejects anything else", () => {
    for (const type of EFFECT_TYPES) {
      expect(effectTypeSchema.parse(type)).toBe(type);
    }
    expect(effectTypeSchema.safeParse("BALANCE_TRANSFER").success).toBe(false);
    expect(effectTypeSchema.safeParse("balance_decrease").success).toBe(false);
    expect(effectTypeSchema.safeParse("").success).toBe(false);
  });

  it("has the 4 authorities of the account model", () => {
    expect(authorityKindSchema.options).toEqual([
      "mint",
      "freeze",
      "upgrade",
      "close",
    ]);
    expect(authorityKindSchema.safeParse("owner").success).toBe(false);
  });

  it("carries magnitude as bigint, including u64::MAX", () => {
    // u64::MAX in delegatedAmount is unlimited allowance: the strongest signal
    // in the system. Through a number it would arrive already rounded.
    const unlimited = 2n ** 64n - 1n;
    const effect: Effect = {
      type: "DELEGATE_GRANT",
      account: "ATokenAccXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      counterparty: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      amount: unlimited,
    };
    expect(effect.amount).toBe(18446744073709551615n);
    expect(effect.amount).not.toBe(Number(unlimited));
  });

  it("allows an effect without fields that do not apply to its type", () => {
    const invocation: Effect = {
      type: "PROGRAM_INVOKE",
      account: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      program: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    };
    expect(invocation.mint).toBeUndefined();
    expect(invocation.amount).toBeUndefined();
  });
});

describe("EffectSet", () => {
  const set: EffectSet = {
    effects: [
      {
        type: "BALANCE_DECREASE",
        account: "ATokenAcc",
        mint: "USDC",
        amount: 400n,
        counterparty: "PoolAcc",
      },
      {
        type: "BALANCE_INCREASE",
        account: "SolAcc",
        mint: "SOL",
        amount: 1_940_000_000n,
      },
      { type: "PROGRAM_INVOKE", account: "JUP6", program: "JUP6" },
      {
        type: "DELEGATE_GRANT",
        account: "ATokenAcc",
        counterparty: "7xKX",
        amount: 2n ** 64n - 1n,
      },
    ],
    slot: 502538365,
    fee: 5000n,
    simulation: { status: "executed", unitsConsumed: 13476 },
    coverage: {
      referenced: ["ATokenAcc", "SolAcc", "JUP6"],
      observed: ["ATokenAcc", "SolAcc", "JUP6"],
      unobserved: [],
    },
  };

  it("derives counterparties without duplicates, to feed the provenance check", () => {
    expect(counterparties(set)).toEqual(["PoolAcc", "7xKX"]);
  });

  it("derives invoked programs", () => {
    expect(invokedPrograms(set)).toEqual(["JUP6"]);
  });

  it("filters by type", () => {
    expect(effectsOfType(set, "DELEGATE_GRANT")).toHaveLength(1);
    expect(effectsOfType(set, "OWNER_CHANGE")).toEqual([]);
  });

  it("reports incomplete coverage when an account was never observed", () => {
    expect(coverageIsComplete(set.coverage)).toBe(true);
    const blind: AccountCoverage = {
      referenced: ["A", "B"],
      observed: ["A"],
      unobserved: ["B"],
    };
    expect(coverageIsComplete(blind)).toBe(false);
  });

  it("tells a failed simulation apart from an unavailable one", () => {
    // Both carry zero effects. If they were indistinguishable, "I could not
    // simulate" would read as "the transaction does nothing" -- an ALLOW.
    const failed: SimulationOutcome = {
      status: "failed",
      error: '{"InsufficientFundsForRent":{"account_index":1}}',
      unitsConsumed: 150,
    };
    const unavailable: SimulationOutcome = {
      status: "unavailable",
      reason: "RPC timeout",
    };
    expect(failed.status).not.toBe(unavailable.status);

    const describeOutcome = (r: SimulationOutcome): string => {
      switch (r.status) {
        case "executed":
          return "ran";
        case "failed":
          return "ran and would fail";
        case "unavailable":
          return "could not simulate";
      }
    };
    expect(describeOutcome(failed)).toBe("ran and would fail");
    expect(describeOutcome(unavailable)).toBe("could not simulate");
  });
});
