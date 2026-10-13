import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { manifestFindings } from "../../src/evaluation/manifest.js";
import { inScope, scopeOf } from "../../src/evaluation/scope.js";
import type { Effect, EffectSet } from "../../src/types/effects.js";
import type { ToolManifest } from "../../src/types/manifest.js";

const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const STRANGER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAYER = "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ";
/** Named nowhere in the tool call below. */
const OUTSIDER = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function setOf(effects: readonly Effect[], feePayer: string | null): EffectSet {
  return {
    effects,
    slot: 1,
    baselineSlot: 1,
    fee: null,
    feePayer,
    messageDigest: null,
    simulation: { status: "executed", unitsConsumed: 1 },
    coverage: {
      referenced: [],
      observed: [],
      unobserved: [],
      blindSpots: [],
      tokenExtensions: [],
      opaqueChanges: [],
      inexactAmounts: [],
      undecodable: [],
      overSimulationLimit: [],
    },
  };
}

/**
 * The shape that used to pass: a `may` pattern loose enough to cover the
 * mechanical noise of a real transaction, and therefore loose enough to cover
 * the same effect on an account nobody named.
 */
const APPROVE: ToolManifest = {
  tool: "approve",
  version: "1",
  args: {
    account: "address",
    delegate: "address",
    mint: "mint",
    amount: "amount",
  },
  must: [{ type: "DELEGATE_GRANT", counterparty: "arg:delegate" }],
  may: [
    { type: "PROGRAM_INVOKE" },
    { type: "BALANCE_DECREASE" },
    { type: "BALANCE_INCREASE" },
  ],
  mustNot: ["AUTHORITY_CHANGE", "OWNER_CHANGE"],
  accountScope: "args_only",
};

const call = {
  name: "approve",
  args: { account: WALLET, delegate: STRANGER, mint: USDC, amount: 100 },
};

describe("the hole a loose `may` leaves open", () => {
  it("passes a permitted balance decrease on an account the tool call named", () => {
    const findings = manifestFindings({
      effects: setOf(
        [
          {
            type: "BALANCE_DECREASE",
            account: WALLET,
            mint: "SOL",
            amount: 2_000n,
          },
        ],
        PAYER,
      ),
      manifest: APPROVE,
      toolCall: call,
    });
    expect(findings.filter((f) => f.check === "scope")).toEqual([]);
  });

  it("catches the same decrease on an account nobody named", () => {
    // `may` allows a balance decrease, because an approve pays rent. It does
    // not allow draining a second account, and before the scope check there
    // was nothing in the system that could tell the two apart.
    const findings = manifestFindings({
      effects: setOf(
        [
          {
            type: "BALANCE_DECREASE",
            account: STRANGER,
            mint: "SOL",
            amount: 900_000_000n,
          },
        ],
        PAYER,
      ),
      manifest: APPROVE,
      toolCall: {
        name: "approve",
        args: { account: WALLET, delegate: WALLET, mint: USDC, amount: 100 },
      },
    });
    const scope = findings.find((f) => f.check === "scope");
    expect(scope?.rule).toBe("scope.outside_args_only");
    expect(scope?.severity).toBe("high");
    expect(scope?.detail["account"]).toBe(STRANGER);
  });

  it("leaves the fee payer alone", () => {
    // Every transaction charges its payer. Without this the fee would be an
    // out-of-scope loss on every single call.
    const findings = manifestFindings({
      effects: setOf(
        [
          {
            type: "BALANCE_DECREASE",
            account: PAYER,
            mint: "SOL",
            amount: 5_000n,
          },
        ],
        PAYER,
      ),
      manifest: APPROVE,
      toolCall: call,
    });
    expect(findings.filter((f) => f.check === "scope")).toEqual([]);
  });

  it("says nothing about an account that merely gains", () => {
    // A pool receiving value is not a loss to anyone, and provenance already
    // asks who the beneficiary is. Reporting it here too would put a finding
    // on every swap.
    const findings = manifestFindings({
      effects: setOf(
        [
          {
            type: "BALANCE_INCREASE",
            account: STRANGER,
            mint: "SOL",
            amount: 900_000_000n,
          },
        ],
        PAYER,
      ),
      manifest: APPROVE,
      toolCall: call,
    });
    expect(findings.filter((f) => f.check === "scope")).toEqual([]);
  });

  it("reports nothing at all when the manifest declares itself open", () => {
    const findings = manifestFindings({
      effects: setOf(
        [{ type: "ACCOUNT_CLOSE", account: STRANGER }],
        PAYER,
      ),
      manifest: { ...APPROVE, accountScope: "open", mustNot: [] },
      toolCall: call,
    });
    expect(findings.filter((f) => f.check === "scope")).toEqual([]);
  });
});

describe("what `derived` means", () => {
  const manifest: ToolManifest = {
    ...APPROVE,
    tool: "transfer_token",
    accountScope: "args_plus_derived",
  };

  it("derives the associated token account the same way the chain does", () => {
    // Cross-checked against an independent implementation: if our derivation
    // drifts, every legitimate token transfer starts reporting out of scope.
    const expected = getAssociatedTokenAddressSync(
      new PublicKey(USDC),
      new PublicKey(WALLET),
    ).toBase58();
    const scope = scopeOf(manifest, call, PAYER);
    expect(scope.derived.has(expected)).toBe(true);
  });

  it("accepts a token account that is not the associated one, when its owner was named", () => {
    // Perfectly legitimate and impossible to predict with address maths. The
    // account's own bytes say who controls it, and that is stronger evidence
    // than a derivation.
    const effect: Effect = {
      type: "BALANCE_DECREASE",
      account: OUTSIDER,
      mint: USDC,
      amount: 10n,
      owner: WALLET,
    };
    expect(inScope(effect, scopeOf(manifest, call, PAYER))).toBe(true);
  });

  it("still refuses a token account owned by somebody else", () => {
    const effect: Effect = {
      type: "BALANCE_DECREASE",
      account: OUTSIDER,
      mint: USDC,
      amount: 10n,
      owner: OUTSIDER,
    };
    expect(inScope(effect, scopeOf(manifest, call, PAYER))).toBe(false);
  });

  it("does not let ownership widen a scope declared args_only", () => {
    const effect: Effect = {
      type: "BALANCE_DECREASE",
      account: OUTSIDER,
      mint: USDC,
      amount: 10n,
      owner: WALLET,
    };
    expect(inScope(effect, scopeOf(APPROVE, call, PAYER))).toBe(false);
  });

  it("does not choke on an argument that is not a public key", () => {
    // "SOL" in a mint argument, or an address elided for display. Neither is
    // derivable, and neither may throw.
    const scope = scopeOf(manifest, {
      name: "transfer_token",
      args: { account: WALLET, delegate: "HkDfvs…", mint: "SOL", amount: 1 },
    }, PAYER);
    expect(scope.named.has(WALLET)).toBe(true);
    expect(scope.derived.size).toBe(0);
  });
});
