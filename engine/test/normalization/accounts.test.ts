import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  type VersionedMessage,
} from "@solana/web3.js";
import {
  addressAt,
  invokedProgramsOf,
  resolveAccounts,
} from "../../src/normalization/accounts.js";
import {
  FixtureRpcClient,
  loadFixture,
  type Fixture,
} from "../../src/normalization/fixture.js";
import type {
  AccountsRead,
  LookupTableRead,
  RpcClient,
  RpcResult,
  SimulationResponse,
} from "../../src/normalization/rpc.js";

function open(name: string): Fixture {
  const raw: unknown = JSON.parse(
    readFileSync(`test/fixtures/${name}.json`, "utf8"),
  );
  const loaded = loadFixture(raw);
  if (!loaded.ok) throw new Error(loaded.failure.message);
  return loaded.value;
}

const FAKE_BLOCKHASH = PublicKey.default.toBase58();

/** A lookup table built offline, with addresses we control. */
function table(
  address: PublicKey,
  entries: PublicKey[],
): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: address,
    state: {
      deactivationSlot: 2n ** 64n - 1n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: entries,
    },
  });
}

/** An RpcClient that only answers lookup tables. Everything else is unused here. */
function lookupOnlyRpc(read: RpcResult<LookupTableRead>): RpcClient {
  return {
    readAccounts: async (): Promise<RpcResult<AccountsRead>> => ({
      ok: false,
      failure: { step: "readAccounts", message: "not used in this test" },
    }),
    simulate: async (): Promise<RpcResult<SimulationResponse>> => ({
      ok: false,
      failure: { step: "simulate", message: "not used in this test" },
    }),
    readLookupTables: async (): Promise<RpcResult<LookupTableRead>> => read,
    feeFor: async (): Promise<RpcResult<bigint | null>> => ({
      ok: true,
      value: null,
    }),
    identifyNetwork: async (): Promise<RpcResult<string>> => ({
      ok: true,
      value: "test",
    }),
  };
}

describe("a message with no lookup tables", () => {
  it("resolves every account with no network call at all", async () => {
    const fixture = open("unlimited-approve");
    const rpc = new FixtureRpcClient(fixture);
    const message: VersionedMessage = rpc.transaction().message;

    const resolved = await resolveAccounts(message, rpc);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    expect(resolved.value.accounts.length).toBe(
      message.staticAccountKeys.length,
    );
    expect(resolved.value.unresolvedTables).toEqual([]);
    expect(resolved.value.accounts.every((a) => a.source === "static")).toBe(
      true,
    );
  });

  it("marks the fee payer as the only signer, at index 0", async () => {
    const fixture = open("transfer-sol");
    const rpc = new FixtureRpcClient(fixture);
    const resolved = await resolveAccounts(rpc.transaction().message, rpc);
    if (!resolved.ok) return;

    const signers = resolved.value.accounts.filter((a) => a.signer);
    expect(signers).toHaveLength(1);
    expect(signers[0]?.index).toBe(0);
    expect(signers[0]?.address).toBe(fixture.before.addresses[0]);
    expect(signers[0]?.writable).toBe(true);
  });

  it("asks only for writable accounts, never for programs", async () => {
    const fixture = open("create-ata");
    const rpc = new FixtureRpcClient(fixture);
    const resolved = await resolveAccounts(rpc.transaction().message, rpc);
    if (!resolved.ok) return;

    const { accounts, toObserve } = resolved.value;
    expect(toObserve.length).toBeLessThan(accounts.length);
    // Programs are readonly by construction, so they must not be observed.
    expect(toObserve).not.toContain(
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    );
    expect(toObserve).not.toContain("11111111111111111111111111111111");
    // The mint is readonly here too: reading it is the decimals lookup's job.
    expect(toObserve).not.toContain(
      "So11111111111111111111111111111111111111112",
    );
    for (const address of toObserve) {
      expect(accounts.find((a) => a.address === address)?.writable).toBe(true);
    }
  });
});

describe("a message that uses lookup tables", () => {
  const tableKey = Keypair.generate().publicKey;
  const writableEntry = Keypair.generate().publicKey;
  const readonlyEntry = Keypair.generate().publicKey;
  const payer = Keypair.generate().publicKey;

  /** transfer to a writable lookup entry, plus a readonly one carried along. */
  function messageWithLookup(): VersionedMessage {
    const lookup = table(tableKey, [writableEntry, readonlyEntry]);
    return new TransactionMessage({
      payerKey: payer,
      recentBlockhash: FAKE_BLOCKHASH,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer,
          toPubkey: writableEntry,
          lamports: 1n,
        }),
        SystemProgram.transfer({
          fromPubkey: payer,
          toPubkey: readonlyEntry,
          lamports: 1n,
        }),
      ],
    }).compileToV0Message([lookup]);
  }

  it("resolves lookup indexes into real addresses", async () => {
    const message = messageWithLookup();
    expect(message.addressTableLookups).toHaveLength(1);

    const rpc = lookupOnlyRpc({
      ok: true,
      value: {
        tables: [
          {
            table: tableKey.toBase58(),
            addresses: [writableEntry.toBase58(), readonlyEntry.toBase58()],
          },
        ],
        unresolved: [],
      },
    });
    const resolved = await resolveAccounts(message, rpc);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const fromLookup = resolved.value.accounts.filter(
      (a) => a.source === "lookup",
    );
    expect(fromLookup.length).toBeGreaterThan(0);
    expect(fromLookup.map((a) => a.address)).toContain(
      writableEntry.toBase58(),
    );
    // Every lookup account records which table and index it came from.
    for (const account of fromLookup) {
      expect(account.table?.address).toBe(tableKey.toBase58());
      expect(account.signer).toBe(false);
    }
  });

  it("keeps the runtime order, so instruction indexes still point correctly", async () => {
    const message = messageWithLookup();
    const rpc = lookupOnlyRpc({
      ok: true,
      value: {
        tables: [
          {
            table: tableKey.toBase58(),
            addresses: [writableEntry.toBase58(), readonlyEntry.toBase58()],
          },
        ],
        unresolved: [],
      },
    });
    const resolved = await resolveAccounts(message, rpc);
    if (!resolved.ok) return;

    // Each instruction's account indexes must resolve to the addresses the
    // instruction was built with.
    const first = message.compiledInstructions[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const addresses = first.accountKeyIndexes.map((i) =>
      addressAt(resolved.value.accounts, i),
    );
    expect(addresses).toContain(payer.toBase58());
    expect(addresses).toContain(writableEntry.toBase58());
    expect(invokedProgramsOf(message, resolved.value.accounts)).toContain(
      SystemProgram.programId.toBase58(),
    );
  });

  it("records an unreadable table instead of pretending the accounts do not exist", async () => {
    const message = messageWithLookup();
    const rpc = lookupOnlyRpc({
      ok: true,
      value: {
        tables: [],
        unresolved: [
          { table: tableKey.toBase58(), reason: "table does not exist" },
        ],
      },
    });
    const resolved = await resolveAccounts(message, rpc);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    // Partial blindness is reported, not swallowed: the static accounts are
    // still there, and the gap is named.
    expect(resolved.value.accounts.every((a) => a.source === "static")).toBe(
      true,
    );
    expect(resolved.value.unresolvedTables.length).toBeGreaterThan(0);
    expect(resolved.value.unresolvedTables[0]?.table).toBe(tableKey.toBase58());
  });

  it("records an index that falls outside the table", async () => {
    const message = messageWithLookup();
    const rpc = lookupOnlyRpc({
      ok: true,
      // A table that reads fine but is shorter than the message expects.
      value: {
        tables: [{ table: tableKey.toBase58(), addresses: [] }],
        unresolved: [],
      },
    });
    const resolved = await resolveAccounts(message, rpc);
    if (!resolved.ok) return;
    expect(
      resolved.value.unresolvedTables.some((u) =>
        u.reason.includes("out of range"),
      ),
    ).toBe(true);
  });

  it("propagates a transport failure instead of reporting empty coverage", async () => {
    const message = messageWithLookup();
    const rpc = lookupOnlyRpc({
      ok: false,
      failure: { step: "readLookupTables", message: "fetch failed" },
    });
    const resolved = await resolveAccounts(message, rpc);
    expect(resolved.ok).toBe(false);
  });
});
