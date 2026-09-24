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
      simulation: { status: "executed", unitsConsumed: 1 },
      coverage: { referenced: [], observed: [], unobserved: [] },
    };
    const rules = alwaysCriticalFindings(set).map((f) => f.rule);
    expect(rules).toEqual([
      "always_critical.authority_change",
      "always_critical.owner_change",
    ]);
  });
});

describe("what the evaluation could not see", () => {
  it("makes an unavailable simulation a critical finding", () => {
    const set: EffectSet = {
      effects: [],
      slot: null,
      baselineSlot: null,
      fee: null,
      simulation: { status: "unavailable", reason: "429 Too Many Requests" },
      coverage: { referenced: ["A"], observed: [], unobserved: ["A"] },
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
      simulation: { status: "executed", unitsConsumed: 0 },
      coverage: { referenced: [], observed: [], unobserved: [] },
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
