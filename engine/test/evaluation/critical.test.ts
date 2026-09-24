import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  alwaysCriticalFindings,
  coverageFindings,
  isUnlimitedDelegate,
} from "../../src/evaluation/critical.js";
import {
  FixtureRpcClient,
  loadFixture,
  type Fixture,
} from "../../src/normalization/fixture.js";
import { opaqueExtensionsOf } from "../../src/normalization/spl.js";
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
      simulation: { status: "executed", unitsConsumed: 1 },
      coverage: {
        referenced: [],
        observed: [],
        unobserved: [],
        blindSpots: [],
        tokenExtensions: [],
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

describe("bytes VETO does not read", () => {
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
      simulation: { status: "executed", unitsConsumed: 1 },
      coverage: {
        referenced: ["A"],
        observed: ["A"],
        unobserved: [],
        blindSpots: [],
        tokenExtensions: ["A"],
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
    expect(opaqueExtensionsOf(token, withExtensions([[7, 0], [19, 8]]))).toEqual(
      [],
    );
    expect(opaqueExtensionsOf(token, withExtensions([[14, 32]]))).toEqual([
      "transfer_hook",
    ]);
    expect(opaqueExtensionsOf(token, withExtensions([[12, 32]]))).toEqual([
      "permanent_delegate",
    ]);
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
    const data = withExtensions([[14, 4]]);
    data.writeUInt16LE(9_000, 168); // a length far beyond what is there
    expect(opaqueExtensionsOf(token, data)).toEqual([
      "malformed_extension_list",
    ]);
  });

  it("says nothing about an account no token program owns", () => {
    expect(
      opaqueExtensionsOf("11111111111111111111111111111111", withExtensions([[12, 32]])),
    ).toEqual([]);
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
      simulation: { status: "unavailable", reason: "429 Too Many Requests" },
      coverage: {
        referenced: ["A"],
        observed: [],
        unobserved: ["A"],
        blindSpots: [],
        tokenExtensions: [],
      },
    };
    const findings = coverageFindings(set);
    const unavailable = findings.find(
      (f) => f.rule === "coverage.simulation_unavailable",
    );
    expect(unavailable?.severity).toBe("critical");
    // A blind spot has to cost something, or the cheapest way to pass the
    // evaluation would be to make it impossible.
    expect(
      findings.some((f) => f.rule === "coverage.accounts_unobserved"),
    ).toBe(true);
  });

  it("reports the slot gap between the two sides of the diff", () => {
    const set: EffectSet = {
      effects: [],
      slot: 100,
      baselineSlot: 99,
      fee: null,
      feePayer: null,
      simulation: { status: "executed", unitsConsumed: 0 },
      coverage: {
        referenced: [],
        observed: [],
        unobserved: [],
        blindSpots: [],
        tokenExtensions: [],
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
      simulation: { status: "executed", unitsConsumed: 0 },
      coverage: {
        referenced: ["A", "B"],
        observed: ["A"],
        unobserved: ["B"],
        blindSpots: ["Table1: does not exist"],
        tokenExtensions: [],
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
      simulation: { status: "executed", unitsConsumed: 0 },
      coverage: {
        referenced: ["A", "Program"],
        observed: ["A"],
        unobserved: ["Program"],
        blindSpots: [],
        tokenExtensions: [],
      },
    };
    const unobserved = coverageFindings(set).find(
      (f) => f.rule === "coverage.accounts_unobserved",
    );
    expect(unobserved?.severity).toBe("low");
  });
});
