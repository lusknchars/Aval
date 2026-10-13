import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FixtureRpcClient,
  loadFixture,
  readTransaction,
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
    feeFor: async (): Promise<RpcResult<bigint | null>> => base.feeFor(),
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

    // A readonly account -- the System Program here -- is referenced and
    // never observed, and that is the DESIGN: it cannot change state. It is
    // not a gap, so it must not show up as one. Counting it made the coverage
    // finding fire on every ordinary transaction.
    expect(set.coverage.referenced).toContain(
      "11111111111111111111111111111111",
    );
    expect(set.coverage.unobserved).toEqual([]);
    expect(coverageIsComplete(set.coverage)).toBe(true);
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
    // No post-state exists for a failed run, so there is nothing to diff and
    // nothing was observed. Claiming otherwise would tell the evaluation layer
    // it has visibility it does not have.
    expect(set.effects).toEqual([]);
    expect(set.coverage.observed).toEqual([]);
    // Every account it MEANT to observe, not every account referenced: a
    // readonly account going unobserved is the design, not a gap.
    expect(set.coverage.unobserved.length).toBeGreaterThan(0);
    expect(
      set.coverage.unobserved.every((a) =>
        set.coverage.referenced.includes(a),
      ),
    ).toBe(true);
  });
});

/** A client whose simulation never answers. */
function hangingClient(base: FixtureRpcClient): RpcClient {
  return {
    readAccounts: async (addresses): Promise<RpcResult<AccountsRead>> =>
      base.readAccounts(addresses),
    simulate: (): Promise<RpcResult<SimulationResponse>> =>
      new Promise(() => {
        // Never settles. A network that accepts the connection and then goes
        // quiet looks exactly like this.
      }),
    readLookupTables: async (addresses): Promise<RpcResult<LookupTableRead>> =>
      base.readLookupTables(addresses),
    feeFor: async (): Promise<RpcResult<bigint | null>> => base.feeFor(),
    identifyNetwork: async (): Promise<RpcResult<string>> =>
      base.identifyNetwork(),
  };
}

describe("a client that answers without a post-state", () => {
  /** Succeeds, and carries no post-state for the accounts that were asked for. */
  function emptyPostState(base: FixtureRpcClient): RpcClient {
    return {
      readAccounts: async (a): Promise<RpcResult<AccountsRead>> =>
        base.readAccounts(a),
      simulate: async (tx, o): Promise<RpcResult<SimulationResponse>> => {
        const real = await base.simulate(tx, o);
        return real.ok
          ? { ok: true, value: { ...real.value, accounts: [] } }
          : real;
      },
      readLookupTables: async (a): Promise<RpcResult<LookupTableRead>> =>
        base.readLookupTables(a),
      feeFor: async (): Promise<RpcResult<bigint | null>> => base.feeFor(),
      identifyNetwork: async (): Promise<RpcResult<string>> =>
        base.identifyNetwork(),
    };
  }

  it("does not invent a closure for every account it asked about", async () => {
    // Zipping our requested list against a shorter response by position makes
    // every entry null, and a null post-state for an account that existed
    // reads as "the account is gone". The result was a full set of phantom
    // closures AND a coverage report claiming everything had been observed --
    // the second half being the dangerous one, because it is a claim of
    // visibility the run never had.
    const fixture = open("transfer-sol");
    const rpc = emptyPostState(new FixtureRpcClient(fixture));
    const set = await normalize(readTransaction(fixture), rpc);

    expect(set.effects.filter((e) => e.type === "ACCOUNT_CLOSE")).toEqual([]);
    expect(set.simulation.status).toBe("unavailable");
    expect(set.coverage.observed).toEqual([]);
  });
});

describe("what the verdict is about", () => {
  it("binds to the signable message, not to the signed transaction", async () => {
    // A verdict with nothing tying it to specific bytes is a verdict about
    // nothing in particular: an agent can be handed "allow" for one
    // transaction and put its signature on another.
    const fixture = open("transfer-sol");
    const rpc = new FixtureRpcClient(fixture);
    const set = await normalize(rpc.transaction(), rpc);

    const tx = readTransaction(fixture);
    const expected = createHash("sha256")
      .update(Buffer.from(tx.message.serialize()))
      .digest("hex");
    expect(set.messageDigest).toBe(expected);

    // And the digest has to survive signing. Signatures are part of a
    // serialized TRANSACTION, so hashing the whole thing would produce a
    // value that changes at the moment of signing -- useless for binding.
    const signed = readTransaction(fixture);
    signed.signatures[0] = new Uint8Array(64).fill(7);
    const afterSigning = createHash("sha256")
      .update(Buffer.from(signed.message.serialize()))
      .digest("hex");
    expect(afterSigning).toBe(set.messageDigest);
  });
});

describe("a decision that never arrives", () => {
  it("degrades instead of waiting forever", async () => {
    // The client here has no deadline of its own, which is the point: an
    // RpcClient is an interface, and an integrator's implementation may have
    // none. Whoever promises an answer owns the deadline.
    const fixture = open("transfer-sol");
    const rpc = hangingClient(new FixtureRpcClient(fixture));
    const started = Date.now();
    const set = await normalize(readTransaction(fixture), rpc, {
      deadlineMs: 120,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(set.simulation.status).toBe("unavailable");
    if (set.simulation.status === "unavailable") {
      expect(set.simulation.reason).toContain("timed out");
    }
    // And it has to be a DENY, not an empty effect list read as approval.
    expect(set.effects).toEqual([]);
  });
});

describe("the baseline and the simulation come from different moments", () => {
  it("records both slots so the gap is visible, not hidden", async () => {
    const fixture = open("transfer-sol");
    const rpc = new FixtureRpcClient(fixture);
    const set = await normalize(rpc.transaction(), rpc);

    // In a fixture both sides were recorded seconds apart, so the gap is real
    // and reported. Against live RPC it is usually one slot, and anything that
    // touched these accounts in between lands in this diff.
    expect(set.baselineSlot).toBe(fixture.before.slot);
    expect(set.slot).toBe(fixture.simulation.slot);
    expect(set.baselineSlot).not.toBeNull();
  });

  it("leaves both slots null when nothing could be read", async () => {
    const base = new FixtureRpcClient(open("transfer-sol"));
    const set = await normalize(
      base.transaction(),
      failingAt("read", base),
      {},
    );
    expect(set.slot).toBeNull();
    expect(set.baselineSlot).toBeNull();
  });
});
