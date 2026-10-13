import { ExtensionType } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  alwaysCriticalFindings,
  coverageFindings,
  feeFindings,
  isUnlimitedDelegate,
} from "../../src/evaluation/critical.js";
import { DEFAULT_THRESHOLDS } from "../../src/types/verdict.js";
import {
  FixtureRpcClient,
  loadFixture,
  type Fixture,
} from "../../src/normalization/fixture.js";
import {
  authorityBearingProgram,
  opaqueExtensionsOf,
} from "../../src/normalization/spl.js";
import { normalize } from "../../src/normalization/normalize.js";
import type { EffectSet } from "../../src/types/effects.js";

function open(name: string): Fixture {
  const raw: unknown = JSON.parse(
    readFileSync(`test/fixtures/${name}.json`, "utf8"),
  );
  const loaded = loadFixture(raw);
  if (!loaded.ok) throw new Error(loaded.failure.message);
  return loaded.value;
}

async function effectSetOf(name: string): Promise<EffectSet> {
  const rpc = new FixtureRpcClient(open(name));
  return normalize(rpc.transaction(), rpc);
}

describe("the safety net, with no manifest at all", () => {
  it("fires on the unlimited delegate from a real recorded simulation", async () => {
    const set = await effectSetOf("unlimited-approve");
    const findings = alwaysCriticalFindings(set);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("always_critical.unlimited_delegate");
    expect(findings[0]?.severity).toBe("critical");
    expect(findings[0]?.detail["amount"]).toBe("18446744073709551615");
    // The delegate is named, which is what provenance will be asked about.
    expect(findings[0]?.detail["delegate"]).not.toBeNull();
  });

  it("stays silent on ordinary activity", async () => {
    // A transfer and an ATA creation are the shape of normal agent work. A
    // net that fires here would be turned off in a week.
    expect(alwaysCriticalFindings(await effectSetOf("transfer-sol"))).toEqual(
      [],
    );
    expect(alwaysCriticalFindings(await effectSetOf("create-ata"))).toEqual([]);
    expect(alwaysCriticalFindings(await effectSetOf("close-account"))).toEqual(
      [],
    );
  });

  it("tells an unlimited delegate apart from a bounded one", () => {
    expect(
      isUnlimitedDelegate({
        type: "DELEGATE_GRANT",
        account: "A",
        counterparty: "B",
        amount: 18_446_744_073_709_551_615n,
      }),
    ).toBe(true);
    // A bounded allowance is what a legitimate approve looks like. It is not
    // harmless, but it is the manifest's business, not the safety net's.
    expect(
      isUnlimitedDelegate({
        type: "DELEGATE_GRANT",
        account: "A",
        counterparty: "B",
        amount: 1_000_000n,
      }),
    ).toBe(false);
    expect(
      isUnlimitedDelegate({
        type: "BALANCE_DECREASE",
        account: "A",
        amount: 1n,
      }),
    ).toBe(false);
  });

  it("fires on authority and owner changes", () => {
    const set: EffectSet = {
      effects: [
        {
          type: "AUTHORITY_CHANGE",
          account: "Mint1",
          authorityKind: "mint",
          counterparty: "Attacker",
        },
        { type: "OWNER_CHANGE", account: "TokenAcc", counterparty: "Attacker" },
      ],
      slot: 1,
      baselineSlot: 1,
      fee: null,
      feePayer: null,
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
    const rules = alwaysCriticalFindings(set).map((f) => f.rule);
    expect(rules).toEqual([
      "always_critical.authority_change",
      "always_critical.owner_change",
    ]);
  });
});

/**
 * A Token-2022 buffer: the 165-byte base layout, the account type byte, then
 * TLV entries of `u16 type, u16 length, value`.
 */
function withExtensions(entries: readonly [number, number][]): Buffer {
  const body = entries.reduce((n, [, length]) => n + 4 + length, 0);
  const data = Buffer.alloc(166 + body + 8);
  data.writeUInt8(1, 165); // account type: Account
  let offset = 166;
  for (const [type, length] of entries) {
    data.writeUInt16LE(type, offset);
    data.writeUInt16LE(length, offset + 2);
    offset += 4 + length;
  }
  return data;
}

describe("bytes AVAL does not read", () => {
  it("reports Token-2022 extensions on an account it did read", () => {
    // The account decoded fine: mint, owner, amount and delegate are all
    // correct. What is unread is everything the extensions add -- a transfer
    // hook runs an arbitrary program on every movement, a permanent delegate
    // lets a third party move the tokens forever -- and none of that would
    // ever surface as an effect.
    const set: EffectSet = {
      effects: [],
      slot: 1,
      baselineSlot: 1,
      fee: null,
      feePayer: null,
      messageDigest: null,
      simulation: { status: "executed", unitsConsumed: 1 },
      coverage: {
        referenced: ["A"],
        observed: ["A"],
        unobserved: [],
        blindSpots: [],
        tokenExtensions: ["A"],
        opaqueChanges: [],
        inexactAmounts: [],
        undecodable: [],
        overSimulationLimit: [],
      },
    };
    const finding = coverageFindings(set).find(
      (f) => f.rule === "coverage.token_extensions",
    );
    expect(finding?.severity).toBe("medium");
  });

  it("tells a dangerous extension from a decorative one", () => {
    const token = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    // Reporting every Token-2022 account made every legitimate transfer of
    // such a token produce a finding -- measured on real mainnet traffic.
    const benign = withExtensions([
      [ExtensionType.ImmutableOwner, 0],
      [ExtensionType.TokenMetadata, 8],
    ]);
    expect(opaqueExtensionsOf(token, benign)).toEqual([]);
    expect(
      opaqueExtensionsOf(token, withExtensions([[ExtensionType.TransferHook, 32]])),
    ).toEqual(["TransferHook"]);
    expect(
      opaqueExtensionsOf(
        token,
        withExtensions([[ExtensionType.PermanentDelegate, 32]]),
      ),
      // The value is read now: thirty-two zero bytes is the all-ones address.
    ).toEqual(["PermanentDelegate(11111111111111111111111111111111)"]);
    // Harmless in every other sense, and still reported: both change the
    // relationship between the raw amount the diff reads and the number a
    // human types, which is what the magnitude check converts between.
    expect(
      opaqueExtensionsOf(
        token,
        withExtensions([[ExtensionType.InterestBearingConfig, 40]]),
      ),
    ).toEqual(["InterestBearingConfig"]);
  });

  it("treats an extension it has never heard of as opaque", () => {
    // New extension types get added to the program over time. Assuming an
    // unknown one is harmless is how a detector goes quiet on the very thing
    // it was built for.
    const token = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    expect(opaqueExtensionsOf(token, withExtensions([[250, 4]]))).toEqual([
      "unknown_extension_250",
    ]);
  });

  it("reports a list that runs past the buffer instead of trusting it", () => {
    const token = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    const data = withExtensions([[ExtensionType.TransferHook, 4]]);
    data.writeUInt16LE(9_000, 168); // a length far beyond what is there
    expect(opaqueExtensionsOf(token, data)).toEqual([
      "malformed_extension_list",
    ]);
  });

  it("says nothing about an account no token program owns", () => {
    expect(
      opaqueExtensionsOf(
        "11111111111111111111111111111111",
        withExtensions([[ExtensionType.PermanentDelegate, 32]]),
      ),
    ).toEqual([]);
  });
});

describe("the fee nothing else looks at", () => {
  const withFee = (fee: bigint | null): EffectSet => ({
    effects: [],
    slot: 1,
    baselineSlot: 1,
    fee,
    feePayer: "Payer",
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
  });

  it("bounds a priority fee, because the diff deliberately excludes it", () => {
    // The fee is taken out of the payer's balance change on purpose -- it is
    // the cost of asking, not part of what was asked for. The consequence is
    // that nothing in any manifest bounds it, and a priority fee is an
    // arbitrary amount of SOL leaving the wallet. Paying it to validators
    // empties the wallet just as well as paying it to an attacker.
    const finding = feeFindings(
      withFee(2_000_000_000n),
      DEFAULT_THRESHOLDS,
    ).find((f) => f.rule === "magnitude.fee_above_ceiling");
    expect(finding?.severity).toBe("high");
  });

  it("says nothing about an ordinary fee, or one it does not know", () => {
    expect(feeFindings(withFee(5_000n), DEFAULT_THRESHOLDS)).toEqual([]);
    expect(feeFindings(withFee(null), DEFAULT_THRESHOLDS)).toEqual([]);
  });
});

describe("changes AVAL produced no effect for", () => {
  it("reports a stake account whose bytes moved", () => {
    // The diff reports what it reads: lamports, and the two token layouts.
    // A stake account's authorities are neither, so handing over the
    // withdrawer produces no effect at all -- which downstream is
    // indistinguishable from "this transaction does nothing".
    const set: EffectSet = {
      effects: [],
      slot: 1,
      baselineSlot: 1,
      fee: null,
      feePayer: null,
      messageDigest: null,
      simulation: { status: "executed", unitsConsumed: 1 },
      coverage: {
        referenced: ["S"],
        observed: ["S"],
        unobserved: [],
        blindSpots: [],
        tokenExtensions: [],
        opaqueChanges: ["S: stake"],
        inexactAmounts: [],
        undecodable: [],
        overSimulationLimit: [],
      },
    };
    const finding = coverageFindings(set).find(
      (f) => f.rule === "coverage.undecoded_authority_account",
    );
    expect(finding?.severity).toBe("high");
  });

  it("knows which programs hold authority and which merely hold state", () => {
    // An AMM pool changing is not a gap: the user's assets live in token
    // accounts, which are read. A stake account changing is.
    expect(
      authorityBearingProgram("Stake11111111111111111111111111111111111111"),
    ).toBe("stake");
    expect(
      authorityBearingProgram("BPFLoaderUpgradeab1e11111111111111111111111"),
    ).toBe("upgradeable_loader");
    expect(
      authorityBearingProgram("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
    ).toBeNull();
  });
});

describe("what the evaluation could not see", () => {
  it("makes an unavailable simulation a critical finding", () => {
    const set: EffectSet = {
      effects: [],
      slot: null,
      baselineSlot: null,
      fee: null,
      feePayer: null,
      messageDigest: null,
      simulation: { status: "unavailable", reason: "429 Too Many Requests" },
      coverage: {
        referenced: ["A"],
        observed: [],
        unobserved: ["A"],
        blindSpots: [],
        tokenExtensions: [],
        opaqueChanges: [],
        inexactAmounts: [],
        undecodable: [],
        overSimulationLimit: [],
      },
    };
    const findings = coverageFindings(set);
    const unavailable = findings.find(
      (f) => f.rule === "coverage.simulation_unavailable",
    );
    expect(unavailable?.severity).toBe("critical");
    // The blind spot costs something -- a CRITICAL, which is a deny on its
    // own. What it must not do is cost twice: reporting "no account was
    // observed" on top of "nothing ran" is the same fact said again, and a
    // second line that changes no decision is how a check earns being
    // switched off.
    expect(
      findings.some((f) => f.rule === "coverage.accounts_unobserved"),
    ).toBe(false);
  });

  it("reports the slot gap between the two sides of the diff", () => {
    const set: EffectSet = {
      effects: [],
      slot: 100,
      baselineSlot: 99,
      fee: null,
      feePayer: null,
      messageDigest: null,
      simulation: { status: "executed", unitsConsumed: 0 },
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
    expect(
      coverageFindings(set).some(
        (f) => f.rule === "coverage.baseline_slot_gap",
      ),
    ).toBe(true);
  });

  it("notes a transaction that would fail without calling it dangerous", async () => {
    const set = await effectSetOf("rent-failure");
    const findings = coverageFindings(set);
    const failed = findings.find(
      (f) => f.rule === "coverage.transaction_would_fail",
    );
    expect(failed?.severity).toBe("low");
  });
});

describe("a real blind spot is not the same as an expected one", () => {
  it("raises a high finding when a lookup table could not be read", () => {
    const set: EffectSet = {
      effects: [],
      slot: 10,
      baselineSlot: 10,
      fee: null,
      feePayer: null,
      messageDigest: null,
      simulation: { status: "executed", unitsConsumed: 0 },
      coverage: {
        referenced: ["A", "B"],
        observed: ["A"],
        unobserved: ["B"],
        blindSpots: ["Table1: does not exist"],
        tokenExtensions: [],
        opaqueChanges: [],
        inexactAmounts: [],
        undecodable: [],
        overSimulationLimit: [],
      },
    };
    const findings = coverageFindings(set);
    const blind = findings.find(
      (f) => f.rule === "coverage.unresolved_lookup_table",
    );
    expect(blind?.severity).toBe("high");
  });

  it("keeps unobserved readonly accounts at low severity", () => {
    // Every ordinary transaction has these. At medium they would flag
    // everything, and an alert that always fires teaches people to ignore it.
    const set: EffectSet = {
      effects: [],
      slot: 10,
      baselineSlot: 10,
      fee: null,
      feePayer: null,
      messageDigest: null,
      simulation: { status: "executed", unitsConsumed: 0 },
      coverage: {
        referenced: ["A", "Program"],
        observed: ["A"],
        unobserved: ["Program"],
        blindSpots: [],
        tokenExtensions: [],
        opaqueChanges: [],
        inexactAmounts: [],
        undecodable: [],
        overSimulationLimit: [],
      },
    };
    const unobserved = coverageFindings(set).find(
      (f) => f.rule === "coverage.accounts_unobserved",
    );
    expect(unobserved?.severity).toBe("low");
  });
});
