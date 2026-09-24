import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveAccounts } from "../../src/normalization/accounts.js";
import {
  NATIVE_MINT_LABEL,
  diffAccounts,
} from "../../src/normalization/diff.js";
import {
  FixtureRpcClient,
  loadFixture,
  type Fixture,
} from "../../src/normalization/fixture.js";
import { UNLIMITED_ALLOWANCE } from "../../src/normalization/spl.js";
import type { AccountState } from "../../src/normalization/rpc.js";
import type { Effect } from "../../src/types/effects.js";

function open(name: string): Fixture {
  const raw: unknown = JSON.parse(
    readFileSync(`test/fixtures/${name}.json`, "utf8"),
  );
  const loaded = loadFixture(raw);
  if (!loaded.ok) throw new Error(loaded.failure.message);
  return loaded.value;
}

/** Runs the whole offline path of a fixture: resolve, read, simulate, diff. */
async function effectsOf(
  name: string,
  fee: bigint | null = null,
): Promise<readonly Effect[]> {
  const fixture = open(name);
  const rpc = new FixtureRpcClient(fixture);
  const tx = rpc.transaction();

  const resolved = await resolveAccounts(tx.message, rpc);
  if (!resolved.ok) throw new Error(resolved.failure.message);

  const observe = fixture.before.addresses;
  const before = await rpc.readAccounts(observe);
  if (!before.ok) throw new Error(before.failure.message);
  const after = await rpc.simulate(tx, { accounts: observe });
  if (!after.ok) throw new Error(after.failure.message);

  const toMap = (
    accounts: readonly (AccountState | null)[],
  ): Map<string, AccountState | null> =>
    new Map(observe.map((address, i) => [address, accounts[i] ?? null]));

  const feePayer = observe[0] ?? "";
  return diffAccounts({
    accounts: resolved.value.accounts,
    before: toMap(before.value.accounts),
    after: toMap(after.value.accounts),
    feePayer,
    fee,
    invokedPrograms: [],
  });
}

function ofType(
  effects: readonly Effect[],
  type: Effect["type"],
): readonly Effect[] {
  return effects.filter((e) => e.type === type);
}

describe("a SOL transfer that creates the destination", () => {
  it("reports the decrease, the creation and the increase", async () => {
    const effects = await effectsOf("transfer-sol");
    expect(ofType(effects, "ACCOUNT_CREATE")).toHaveLength(1);

    const decrease = ofType(effects, "BALANCE_DECREASE")[0];
    const increase = ofType(effects, "BALANCE_INCREASE")[0];
    expect(decrease?.mint).toBe(NATIVE_MINT_LABEL);
    expect(increase?.amount).toBe(1_000_000n);
    // What left the payer covers what arrived, plus fee and rent.
    expect(decrease?.amount).toBeGreaterThanOrEqual(increase?.amount ?? 0n);
  });

  it("keeps the network fee out of the payer's decrease", async () => {
    const withoutFee = await effectsOf("transfer-sol");
    const withFee = await effectsOf("transfer-sol", 5000n);
    const before = ofType(withoutFee, "BALANCE_DECREASE")[0]?.amount ?? 0n;
    const after = ofType(withFee, "BALANCE_DECREASE")[0]?.amount ?? 0n;
    // The fee is a protocol cost, not something the user asked for.
    expect(before - after).toBe(5000n);
  });
});

describe("creating an Associated Token Account", () => {
  it("reports the creation and no phantom delegate", async () => {
    const effects = await effectsOf("create-ata");
    const created = ofType(effects, "ACCOUNT_CREATE");
    expect(created).toHaveLength(1);
    // A fresh ATA has 165 zeroed delegate bytes. Reading them as an address
    // would invent a grant that never happened.
    expect(ofType(effects, "DELEGATE_GRANT")).toHaveLength(0);
  });

  it("does not report wrapped SOL twice", async () => {
    const effects = await effectsOf("create-ata");
    const fixture = open("create-ata");
    const ata = fixture.before.addresses[1];
    // The ATA's lamport balance and its token amount are the same value seen
    // twice. Only the token side may be reported.
    const solOnAta = effects.filter(
      (e) =>
        e.account === ata &&
        e.mint === NATIVE_MINT_LABEL &&
        e.type !== "ACCOUNT_CREATE",
    );
    expect(solOnAta).toHaveLength(0);
  });
});

describe("the unlimited approve", () => {
  it("reports DELEGATE_GRANT with u64::MAX", async () => {
    const effects = await effectsOf("unlimited-approve");
    const grants = ofType(effects, "DELEGATE_GRANT");
    expect(grants).toHaveLength(1);

    const grant = grants[0];
    expect(grant?.amount).toBe(UNLIMITED_ALLOWANCE);
    expect(grant?.counterparty).toBeDefined();
    expect(grant?.counterparty).not.toBe("");
    expect(grant?.mint).toBe("So11111111111111111111111111111111111111112");
  });

  it("names the delegate, which is what provenance will be asked about", async () => {
    const fixture = open("unlimited-approve");
    const effects = await effectsOf("unlimited-approve");
    const grant = ofType(effects, "DELEGATE_GRANT")[0];
    // The delegate is the third observed account of the scenario.
    expect(grant?.counterparty).toBe(fixture.before.addresses[2]);
  });
});

describe("an account that was never observed", () => {
  it("produces no effect, because absence is not evidence of no change", () => {
    const effects = diffAccounts({
      accounts: [
        {
          index: 0,
          address: "Observed",
          signer: true,
          writable: true,
          source: "static",
          table: null,
        },
        {
          index: 1,
          address: "NeverObserved",
          signer: false,
          writable: true,
          source: "static",
          table: null,
        },
      ],
      before: new Map([["Observed", null]]),
      after: new Map([["Observed", null]]),
      feePayer: "Observed",
      fee: null,
      invokedPrograms: [],
    });
    expect(effects).toEqual([]);
  });
});

describe("programs", () => {
  it("reports one PROGRAM_INVOKE per invoked program", () => {
    const effects = diffAccounts({
      accounts: [],
      before: new Map(),
      after: new Map(),
      feePayer: "",
      fee: null,
      invokedPrograms: [
        "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        "11111111111111111111111111111111",
      ],
    });
    expect(ofType(effects, "PROGRAM_INVOKE")).toHaveLength(2);
    expect(effects[0]?.program).toBe(
      "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    );
  });
});
