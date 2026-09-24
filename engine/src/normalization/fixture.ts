/**
 * Fixtures: real RPC responses, recorded to disk.
 *
 * They exist so every new piece ships with a test that uses a fixture rather
 * than a network call. `FixtureRpcClient` implements the same `RpcClient`
 * interface as the Helius-backed one, so the normalizer neither knows nor
 * needs to know whether it is talking to mainnet or to a file.
 *
 * FORMAT. JSON.stringify throws on bigint, therefore:
 *   - amounts -> decimal string ("18446744073709551615")
 *   - bytes   -> base64
 * Never a number for a token amount: that is the same precision loss the RPC
 * boundary flags with `lamportsExact`.
 */
import { VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import type {
  AccountState,
  AccountsRead,
  LookupTable,
  LookupTableRead,
  RpcClient,
  RpcResult,
  SimulationOptions,
  SimulationResponse,
} from "./rpc.js";

// ---------------------------------------------------------------- format

const decimalStringSchema = z
  .string()
  .regex(/^\d+$/, "amount must be a decimal integer in a string");

export const recordedAccountSchema = z.object({
  address: z.string(),
  lamports: decimalStringSchema,
  lamportsExact: z.boolean(),
  owner: z.string(),
  executable: z.boolean(),
  dataBase64: z.string(),
});
export type RecordedAccount = z.infer<typeof recordedAccountSchema>;

export const fixtureSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  network: z.enum(["mainnet", "devnet"]),
  recordedAt: z.string(),
  /** Genesis hash of the network at recording time. */
  genesis: z.string(),

  /** The unsigned transaction, serialized. */
  txBase64: z.string(),

  /** The BEFORE read. `addresses` and `accounts` line up by position. */
  before: z.object({
    slot: z.number().int().nonnegative(),
    addresses: z.array(z.string()),
    accounts: z.array(z.union([recordedAccountSchema, z.null()])),
  }),

  /** The simulation response, with the post-state of the requested accounts. */
  simulation: z.object({
    slot: z.number().int().nonnegative(),
    error: z.union([z.string(), z.null()]),
    unitsConsumed: z.union([z.number(), z.null()]),
    logs: z.union([z.array(z.string()), z.null()]),
    requestedAccounts: z.array(z.string()),
    accounts: z.array(z.union([recordedAccountSchema, z.null()])),
    innerInstructions: z
      .array(
        z.object({
          outerIndex: z.number().int().nonnegative(),
          position: z.number().int().nonnegative(),
          program: z.union([z.string(), z.null()]),
          programIndex: z.union([z.number().int(), z.null()]),
          stackHeight: z.union([z.number().int(), z.null()]),
        }),
      )
      .nullable(),
  }),

  /** Contents of any referenced Address Lookup Tables. */
  lookupTables: z.array(
    z.object({ table: z.string(), addresses: z.array(z.string()) }),
  ),
});
export type Fixture = z.infer<typeof fixtureSchema>;

// ---------------------------------------------------------------- conversion

export function recordAccount(
  state: AccountState | null,
): RecordedAccount | null {
  if (state === null) return null;
  return {
    address: state.address,
    lamports: state.lamports.toString(),
    lamportsExact: state.lamportsExact,
    owner: state.owner,
    executable: state.executable,
    dataBase64: state.data.toString("base64"),
  };
}

export function readAccount(
  recorded: RecordedAccount | null,
): AccountState | null {
  if (recorded === null) return null;
  return {
    address: recorded.address,
    lamports: BigInt(recorded.lamports),
    lamportsExact: recorded.lamportsExact,
    owner: recorded.owner,
    executable: recorded.executable,
    data: Buffer.from(recorded.dataBase64, "base64"),
  };
}

export function readTransaction(fixture: Fixture): VersionedTransaction {
  return VersionedTransaction.deserialize(
    Buffer.from(fixture.txBase64, "base64"),
  );
}

/** Reads and validates a fixture already parsed from JSON. */
export function loadFixture(raw: unknown): RpcResult<Fixture> {
  const parsed = fixtureSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      failure: {
        step: "fixture",
        message: `invalid fixture: ${parsed.error.issues[0]?.message ?? "bad shape"}`,
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Indexes by the REQUESTED addresses, matching what was recorded by position.
 * That is what tells "recorded, and the account does not exist" (null in the
 * map) apart from "never recorded" (key absent) -- two things that must not be
 * confused.
 */
export function indexByRequest(
  requested: readonly string[],
  accounts: readonly (RecordedAccount | null)[],
): ReadonlyMap<string, AccountState | null> {
  const map = new Map<string, AccountState | null>();
  requested.forEach((address, i) => {
    map.set(address, readAccount(accounts[i] ?? null));
  });
  return map;
}

// ---------------------------------------------------------------- fake client

/**
 * Serves a fixture through the same interface as the real client. No network.
 *
 * Asking for an address that was never recorded does NOT silently return null:
 * it returns a failure. An account missing from the fixture is a gap in the
 * test, not "an account that does not exist" -- conflating the two would hide
 * a blind spot.
 */
export class FixtureRpcClient implements RpcClient {
  readonly #fixture: Fixture;
  readonly #before: ReadonlyMap<string, AccountState | null>;
  readonly #after: ReadonlyMap<string, AccountState | null>;

  constructor(fixture: Fixture) {
    this.#fixture = fixture;
    this.#before = indexByRequest(
      fixture.before.addresses,
      fixture.before.accounts,
    );
    this.#after = indexByRequest(
      fixture.simulation.requestedAccounts,
      fixture.simulation.accounts,
    );
  }

  get fixture(): Fixture {
    return this.#fixture;
  }

  transaction(): VersionedTransaction {
    return readTransaction(this.#fixture);
  }

  async feeFor(): Promise<RpcResult<bigint | null>> {
    // Fixtures do not record a fee, so the recorded balance change still
    // includes it. Stated rather than guessed at.
    return { ok: true, value: null };
  }

  async identifyNetwork(): Promise<RpcResult<string>> {
    return { ok: true, value: this.#fixture.genesis };
  }

  async readAccounts(
    addresses: readonly string[],
  ): Promise<RpcResult<AccountsRead>> {
    const accounts: (AccountState | null)[] = [];
    for (const address of addresses) {
      if (!this.#before.has(address)) {
        return {
          ok: false,
          failure: {
            step: "readAccounts",
            message: `fixture "${this.#fixture.name}" did not record account ${address}`,
          },
        };
      }
      accounts.push(this.#before.get(address) ?? null);
    }
    return { ok: true, value: { slot: this.#fixture.before.slot, accounts } };
  }

  async simulate(
    _tx: VersionedTransaction,
    options: SimulationOptions,
  ): Promise<RpcResult<SimulationResponse>> {
    const accounts: (AccountState | null)[] = [];
    for (const address of options.accounts) {
      if (!this.#after.has(address)) {
        return {
          ok: false,
          failure: {
            step: "simulate",
            message: `fixture "${this.#fixture.name}" did not record the post-state of ${address}`,
          },
        };
      }
      accounts.push(this.#after.get(address) ?? null);
    }
    const { slot, error, unitsConsumed, logs, innerInstructions } =
      this.#fixture.simulation;
    return {
      ok: true,
      value: {
        slot,
        error,
        unitsConsumed,
        logs,
        requestedAccounts: [...options.accounts],
        accounts,
        innerInstructions,
      },
    };
  }

  async readLookupTables(
    addresses: readonly string[],
  ): Promise<RpcResult<LookupTableRead>> {
    const tables: LookupTable[] = [];
    const unresolved: { table: string; reason: string }[] = [];
    for (const address of addresses) {
      const recorded = this.#fixture.lookupTables.find(
        (t) => t.table === address,
      );
      if (recorded === undefined) {
        unresolved.push({
          table: address,
          reason: `fixture "${this.#fixture.name}" did not record this table`,
        });
        continue;
      }
      tables.push(recorded);
    }
    return { ok: true, value: { tables, unresolved } };
  }
}
