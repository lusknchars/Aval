import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FixtureRpcClient,
  loadFixture,
  type Fixture,
} from "../../src/normalization/fixture.js";
import { normalize } from "../../src/normalization/normalize.js";
import { UNLIMITED_ALLOWANCE } from "../../src/normalization/spl.js";
import type {
  AccountsRead,
  LookupTableRead,
  RpcClient,
  RpcResult,
  SimulationResponse,
} from "../../src/normalization/rpc.js";
import {
  coverageIsComplete,
  counterparties,
  effectsOfType,
} from "../../src/types/effects.js";

function open(name: string): Fixture {
  const raw: unknown = JSON.parse(
    readFileSync(`test/fixtures/${name}.json`, "utf8"),
  );
  const loaded = loadFixture(raw);
  if (!loaded.ok) throw new Error(loaded.failure.message);
  return loaded.value;
}

/** A client that fails at one chosen step and behaves normally elsewhere. */
function failingAt(
  step: "read" | "simulate",
  base: FixtureRpcClient,
): RpcClient {
  return {
    readAccounts: async (addresses): Promise<RpcResult<AccountsRead>> =>
      step === "read"
        ? {
            ok: false,
            failure: { step: "readAccounts", message: "fetch failed" },
          }
        : base.readAccounts(addresses),
    simulate: async (tx, options): Promise<RpcResult<SimulationResponse>> =>
      step === "simulate"
        ? {
            ok: false,
            failure: { step: "simulate", message: "429 Too Many Requests" },
          }
        : base.simulate(tx, options),
    readLookupTables: async (addresses): Promise<RpcResult<LookupTableRead>> =>
      base.readLookupTables(addresses),
    identifyNetwork: async (): Promise<RpcResult<string>> =>
      base.identifyNetwork(),
  };
}

describe("the full path, offline", () => {
  it("normalises the unlimited approve into an EffectSet", async () => {
    const fixture = open("unlimited-approve");
    const rpc = new FixtureRpcClient(fixture);
    const set = await normalize(rpc.transaction(), rpc, { fee: 5000n });

    expect(set.simulation.status).toBe("executed");
    expect(set.slot).toBe(fixture.simulation.slot);
    expect(set.fee).toBe(5000n);

    const grants = effectsOfType(set, "DELEGATE_GRANT");
    expect(grants).toHaveLength(1);
    expect(grants[0]?.amount).toBe(UNLIMITED_ALLOWANCE);

    // The delegate is exactly what the provenance check will be asked about.
    expect(counterparties(set)).toContain(fixture.before.addresses[2]);
  });

  it("reports the programs it invoked, CPIs included", async () => {
    const rpc = new FixtureRpcClient(open("create-ata"));
    const set = await normalize(rpc.transaction(), rpc);
    const programs = effectsOfType(set, "PROGRAM_INVOKE").map((e) => e.program);

    // The ATA program was called from outside; System and Token were reached
    // through CPI and only show up because innerInstructions were requested.
    expect(programs).toContain("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    expect(programs).toContain("11111111111111111111111111111111");
    expect(programs).toContain("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  });

  it("reports coverage over the accounts it actually observed", async () => {
    const fixture = open("transfer-sol");
    const rpc = new FixtureRpcClient(fixture);
    const set = await normalize(rpc.transaction(), rpc);

    expect(set.coverage.referenced.length).toBeGreaterThan(0);
    expect(set.coverage.observed).toEqual(fixture.before.addresses);
    // Readonly accounts are referenced but never observed, and that is stated
    // rather than implied.
    expect(coverageIsComplete(set.coverage)).toBe(false);
    expect(set.coverage.unobserved).toContain(
      "11111111111111111111111111111111",
    );
  });
});

describe("degradation", () => {
  it("an unreadable state becomes unavailable, never an empty effect list", async () => {
    const base = new FixtureRpcClient(open("transfer-sol"));
    const set = await normalize(
      base.transaction(),
      failingAt("read", base),
      {},
    );

    expect(set.simulation.status).toBe("unavailable");
    if (set.simulation.status === "unavailable") {
      expect(set.simulation.reason).toContain("could not read account state");
      expect(set.simulation.reason).toContain("fetch failed");
    }
    // Zero effects with an "executed" status would read as approval. The
    // status is what keeps the two apart.
    expect(set.effects).toEqual([]);
    expect(coverageIsComplete(set.coverage)).toBe(false);
  });

  it("a rate-limited simulation becomes unavailable and names the reason", async () => {
    const base = new FixtureRpcClient(open("create-ata"));
    const set = await normalize(
      base.transaction(),
      failingAt("simulate", base),
      {},
    );

    expect(set.simulation.status).toBe("unavailable");
    if (set.simulation.status === "unavailable") {
      expect(set.simulation.reason).toContain("429");
    }
    expect(set.slot).toBeNull();
  });

  it("a transaction that would fail is reported as failed, not as harmless", async () => {
    const fixture = open("transfer-sol");
    const failing: Fixture = {
      ...fixture,
      simulation: {
        ...fixture.simulation,
        error: '{"InsufficientFundsForRent":{"account_index":1}}',
        accounts: fixture.simulation.accounts.map(() => null),
      },
    };
    const rpc = new FixtureRpcClient(failing);
    const set = await normalize(rpc.transaction(), rpc);

    expect(set.simulation.status).toBe("failed");
    if (set.simulation.status === "failed") {
      expect(set.simulation.error).toContain("InsufficientFundsForRent");
    }
    // No post-state exists for a failed run, so there is nothing to diff.
    expect(set.effects).toEqual([]);
    expect(set.coverage.unobserved.length).toBeGreaterThan(0);
  });
});
