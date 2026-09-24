import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FixtureRpcClient,
  loadFixture,
  readAccount,
  readTransaction,
  recordAccount,
  type Fixture,
} from "../../src/normalization/fixture.js";
import type { AccountState } from "../../src/normalization/rpc.js";

function open(name: string): Fixture {
  const raw: unknown = JSON.parse(readFileSync(`test/fixtures/${name}.json`, "utf8"));
  const loaded = loadFixture(raw);
  if (!loaded.ok) throw new Error(loaded.failure.message);
  return loaded.value;
}

describe("fixture format", () => {
  it("validates the three recorded fixtures", () => {
    for (const name of ["transfer-sol", "create-ata", "unlimited-approve"]) {
      const f = open(name);
      expect(f.network).toBe("devnet");
      expect(f.simulation.error).toBeNull();
      expect(f.before.addresses.length).toBe(f.before.accounts.length);
      expect(f.simulation.requestedAccounts.length).toBe(f.simulation.accounts.length);
    }
  });

  it("refuses an amount recorded as a number", () => {
    // JSON.stringify throws on bigint; that is why lamports is a decimal string.
    const f = open("transfer-sol");
    const tampered = {
      ...f,
      before: { ...f.before, accounts: [{ ...f.before.accounts[0], lamports: 382313590904 }] },
    };
    expect(loadFixture(tampered).ok).toBe(false);
  });

  it("round-trips an account without losing bigint or bytes", () => {
    const state: AccountState = {
      address: "Account1",
      lamports: 18_446_744_073_709_551_615n,
      lamportsExact: false,
      owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      executable: false,
      data: Buffer.from([0, 1, 255, 128]),
    };
    const back = readAccount(recordAccount(state));
    expect(back).toEqual(state);
    expect(back?.lamports).toBe(18_446_744_073_709_551_615n);
  });
});

describe("fixture client", () => {
  it("serves the recorded accounts, with no network", async () => {
    const f = open("transfer-sol");
    const rpc = new FixtureRpcClient(f);
    const read = await rpc.readAccounts(f.before.addresses);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.slot).toBe(f.before.slot);
      expect(read.value.accounts).toHaveLength(f.before.addresses.length);
    }
  });

  it("tells a recorded-missing account apart from one never recorded", async () => {
    const f = open("unlimited-approve");
    const rpc = new FixtureRpcClient(f);
    // The ATA did not exist before: recorded as null, and null is the answer.
    const ata = f.before.addresses[1] ?? "";
    const recorded = await rpc.readAccounts([ata]);
    expect(recorded.ok && recorded.value.accounts[0]).toBeNull();

    // An address never recorded must not silently become "account not found".
    const neverRecorded = await rpc.readAccounts(["NeverRecordedXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"]);
    expect(neverRecorded.ok).toBe(false);
    if (!neverRecorded.ok) expect(neverRecorded.failure.message).toContain("did not record");
  });

  it("serves the post-simulation state carrying the unlimited delegate", async () => {
    const f = open("unlimited-approve");
    const rpc = new FixtureRpcClient(f);
    const sim = await rpc.simulate(rpc.transaction(), { accounts: f.simulation.requestedAccounts });
    expect(sim.ok).toBe(true);
    if (!sim.ok) return;
    expect(sim.value.error).toBeNull();
    const ata = sim.value.accounts[1];
    expect(ata).not.toBeNull();
    if (ata === null || ata === undefined) return;
    expect(ata.data).toHaveLength(165);
    // delegateOption at 72..76, delegatedAmount at 121..129 -- fixed offsets.
    expect(ata.data.readUInt32LE(72)).toBe(1);
    expect(ata.data.readBigUInt64LE(121)).toBe(18_446_744_073_709_551_615n);
  });

  it("returns the transaction with a zeroed signature", () => {
    const f = open("create-ata");
    const tx = readTransaction(f);
    expect(tx.message.version).toBe(0);
    expect(tx.signatures.every((s: Uint8Array) => s.every((b: number) => b === 0))).toBe(true);
  });

  it("identifies the network from the recorded genesis hash", async () => {
    const rpc = new FixtureRpcClient(open("create-ata"));
    const network = await rpc.identifyNetwork();
    expect(network.ok && network.value).toBe("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
  });
});
