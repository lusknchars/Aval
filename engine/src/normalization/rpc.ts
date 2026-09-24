/**
 * The only way out to the network.
 *
 * The normalizer depends on the `RpcClient` INTERFACE, never on web3.js's
 * `Connection`. In production the Helius-backed implementation is used; in
 * tests, a fake one serving a recorded fixture. That is what makes the diff
 * testable with no network at all.
 *
 * A failure is a RESULT, not an exception: `RpcResult` is a discriminated
 * union and the compiler forces every caller to handle the bad case. A
 * simulation that never ran becomes `unavailable` in the EffectSet -- never an
 * empty set of effects, which would be indistinguishable from "the transaction
 * does nothing".
 */
import {
  Connection,
  PublicKey,
  type VersionedTransaction,
} from "@solana/web3.js";
import { z } from "zod";

// ---------------------------------------------------------------- result

export interface RpcFailure {
  /** Which call failed. Feeds the reason of an unavailable EffectSet. */
  readonly step: string;
  /** Already redacted: never contains the URL or an api-key. */
  readonly message: string;
}

export type RpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: RpcFailure };

// ---------------------------------------------------------------- state

/**
 * State of one account, already across the number -> bigint boundary.
 *
 * `lamportsExact` exists because lamports arrives from JSON.parse as a number.
 * Above 2^53-1 the value already came rounded and the original is not
 * recoverable. Flagging that is more honest than converting to bigint and
 * pretending the precision survived.
 */
export interface AccountState {
  readonly address: string;
  readonly lamports: bigint;
  readonly lamportsExact: boolean;
  readonly owner: string;
  readonly executable: boolean;
  readonly data: Buffer;
}

export interface AccountsRead {
  readonly slot: number;
  /** Same order as the requested addresses. null = the account does not exist. */
  readonly accounts: readonly (AccountState | null)[];
}

/**
 * One inner instruction, reduced to what the effect vocabulary needs: which
 * program was called, and from which outer instruction.
 *
 * The RPC returns two different shapes. `jsonParsed` when it recognises the
 * program, carrying the program id directly; the compiled form otherwise,
 * carrying an INDEX into the account list. Both are handled, because a program
 * VETO cares about may well be one the RPC cannot parse.
 */
export interface InnerInstructionRef {
  readonly outerIndex: number;
  readonly position: number;
  /** Set when the RPC gave a program id directly. */
  readonly program: string | null;
  /** Set when the RPC gave an index that still has to be resolved. */
  readonly programIndex: number | null;
  /** Depth of the call. Not typed by the SDK, so it is read defensively. */
  readonly stackHeight: number | null;
}

export interface SimulationResponse {
  readonly slot: number;
  /** null = the transaction would pass. Set = it ran and would fail. */
  readonly error: string | null;
  readonly unitsConsumed: number | null;
  readonly logs: readonly string[] | null;
  /** Requested addresses, in order. The response associates them by position only. */
  readonly requestedAccounts: readonly string[];
  readonly accounts: readonly (AccountState | null)[];
  /** null when not requested, or when the RPC did not return them. */
  readonly innerInstructions: readonly InnerInstructionRef[] | null;
}

/** Contents of an Address Lookup Table, resolved before signing. */
export interface LookupTable {
  readonly table: string;
  readonly addresses: readonly string[];
}

/**
 * The outcome of reading several lookup tables.
 *
 * One table failing does not sink the rest. Resolving three of four and
 * recording the fourth as unresolved is strictly better than reporting
 * nothing: the accounts that did resolve can still be observed, and the gap
 * becomes a coverage finding instead of a total blackout.
 */
export interface LookupTableRead {
  readonly tables: readonly LookupTable[];
  readonly unresolved: readonly {
    readonly table: string;
    readonly reason: string;
  }[];
}

export interface SimulationOptions {
  /** Accounts whose post-state must come back. The RPC performs no discovery. */
  readonly accounts: readonly string[];
  readonly minContextSlot?: number;
  /** Ask for the CPIs. Needed for PROGRAM_INVOKE beyond the outer instructions. */
  readonly innerInstructions?: boolean;
  /**
   * The transaction's original wire bytes, base64.
   *
   * Required for a version 1 transaction: the installed SDK can read a v1
   * message but refuses to serialize one, so re-encoding it is impossible.
   * When the caller already holds the bytes -- which an agent handing over an
   * unsigned transaction always does -- they are passed straight through.
   */
  readonly rawTransactionBase64?: string;
}

/**
 * The contract the normalizer sees. Four methods, nothing else. Swapping
 * Helius for another provider, or for a fixture, is swapping the class.
 */
export interface RpcClient {
  readAccounts(addresses: readonly string[]): Promise<RpcResult<AccountsRead>>;
  simulate(
    tx: VersionedTransaction,
    options: SimulationOptions,
  ): Promise<RpcResult<SimulationResponse>>;
  readLookupTables(
    addresses: readonly string[],
  ): Promise<RpcResult<LookupTableRead>>;
  /** Genesis hash, to confirm the endpoint is the network we expect. */
  identifyNetwork(): Promise<RpcResult<string>>;
}

// ---------------------------------------------------------------- config

export const commitmentSchema = z.enum(["processed", "confirmed", "finalized"]);
export type Commitment = z.infer<typeof commitmentSchema>;

export const networkSchema = z.enum(["mainnet", "devnet"]);
export type Network = z.infer<typeof networkSchema>;

export const GENESIS_BY_NETWORK: Readonly<Record<Network, string>> = {
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};

export interface RpcConfig {
  readonly rpcUrl: string;
  readonly commitment: Commitment;
  readonly network: Network;
}

const rpcUrlSchema = z.url({ protocol: /^https?$/ });
const ENV_VAR_BY_NETWORK: Readonly<Record<Network, string>> = {
  mainnet: "VETO_RPC_URL",
  devnet: "VETO_RPC_URL_DEVNET",
};

/** Reads and validates config. No error message ever repeats the URL value. */
export function readRpcConfig(
  env: NodeJS.ProcessEnv,
  network: Network,
): RpcResult<RpcConfig> {
  const variable = ENV_VAR_BY_NETWORK[network];
  const fail = (message: string): RpcResult<RpcConfig> => ({
    ok: false,
    failure: { step: "config", message },
  });

  const url = env[variable];
  if (url === undefined || url === "") return fail(`${variable} is not set.`);
  if (!rpcUrlSchema.safeParse(url).success)
    return fail(`${variable} is not a valid http(s) URL.`);

  const commitment = commitmentSchema.safeParse(env["VETO_RPC_COMMITMENT"]);
  if (!commitment.success) {
    return fail(
      "VETO_RPC_COMMITMENT missing or invalid. Use processed, confirmed or finalized.",
    );
  }
  return {
    ok: true,
    value: { rpcUrl: url, commitment: commitment.data, network },
  };
}

// ---------------------------------------------------------------- pure

/**
 * The URL carries the api-key in its query string, so the whole URL is a
 * secret. Every error message leaving this module goes through here.
 */
export function redact(text: string, rpcUrl: string): string {
  return text
    .split(rpcUrl)
    .join("<rpc>")
    .replace(/api-key=[^&\s"']+/gi, "api-key=***");
}

/** The number -> bigint boundary, with any precision loss declared. */
export function toLamports(value: number): {
  lamports: bigint;
  exact: boolean;
} {
  if (!Number.isSafeInteger(value)) {
    return { lamports: BigInt(Math.round(value)), exact: false };
  }
  return { lamports: BigInt(value), exact: true };
}

/** Converts an on-chain read into the internal state shape. */
export function onChainState(
  address: string,
  info: {
    lamports: number;
    owner: PublicKey;
    executable: boolean;
    data: Buffer;
  } | null,
): AccountState | null {
  if (info === null) return null;
  const { lamports, exact } = toLamports(info.lamports);
  return {
    address,
    lamports,
    lamportsExact: exact,
    owner: info.owner.toBase58(),
    executable: info.executable,
    data: info.data,
  };
}

/**
 * Converts the simulated post-state. `data` must arrive as
 * ["<base64>", "base64"]; any other shape is refused rather than guessed at.
 */
export function simulatedState(
  address: string,
  info: {
    lamports: number;
    owner: string;
    executable: boolean;
    data: string[];
  } | null,
): RpcResult<AccountState | null> {
  if (info === null) return { ok: true, value: null };
  const [content, encoding, ...rest] = info.data;
  if (content === undefined || encoding !== "base64" || rest.length > 0) {
    return {
      ok: false,
      failure: {
        step: "simulate",
        message: `post-state of ${address} has an unexpected encoding`,
      },
    };
  }
  const data = Buffer.from(content, "base64");
  // Buffer.from silently ignores invalid characters; the round trip catches it.
  if (data.toString("base64") !== content) {
    return {
      ok: false,
      failure: {
        step: "simulate",
        message: `post-state of ${address} is not canonical base64`,
      },
    };
  }
  const { lamports, exact } = toLamports(info.lamports);
  return {
    ok: true,
    value: {
      address,
      lamports,
      lamportsExact: exact,
      owner: info.owner,
      executable: info.executable,
      data,
    },
  };
}

// ---------------------------------------------------------------- web3.js

/**
 * Reduces the RPC's inner instructions to program references.
 *
 * The SDK types these as parsed or partially decoded, but the RPC also emits a
 * compiled form with numeric indexes when it cannot parse the program. The
 * shape is narrowed at runtime rather than trusted, and an unrecognised shape
 * is skipped instead of guessed at.
 */
export function normaliseInnerInstructions(
  groups:
    | readonly { index: number; instructions: readonly object[] }[]
    | null
    | undefined,
): readonly InnerInstructionRef[] | null {
  if (groups === undefined || groups === null) return null;
  const refs: InnerInstructionRef[] = [];
  for (const group of groups) {
    group.instructions.forEach((instruction, position) => {
      const stackHeightRaw: unknown =
        "stackHeight" in instruction ? instruction.stackHeight : undefined;
      const stackHeight =
        typeof stackHeightRaw === "number" ? stackHeightRaw : null;

      if ("programId" in instruction) {
        refs.push({
          outerIndex: group.index,
          position,
          program: String(instruction.programId),
          programIndex: null,
          stackHeight,
        });
        return;
      }
      if ("programIdIndex" in instruction) {
        const index: unknown = instruction.programIdIndex;
        if (typeof index === "number") {
          refs.push({
            outerIndex: group.index,
            position,
            program: null,
            programIndex: index,
            stackHeight,
          });
        }
      }
    });
  }
  return refs;
}

/**
 * The RPC's simulateTransaction response, validated at the boundary.
 *
 * Parsed here rather than through the SDK for two reasons. The SDK cannot
 * serialize a v1 transaction, which rules out a fifth of real mainnet traffic;
 * and its validation only accepts inner instructions in parsed form, rejecting
 * the compiled shape the RPC emits for programs it cannot decode. Talking
 * JSON-RPC directly removes both limits.
 */
const simulateResponseSchema = z.object({
  context: z.object({ slot: z.number() }),
  value: z.object({
    err: z.unknown().nullable(),
    logs: z.array(z.string()).nullable().optional(),
    accounts: z
      .array(
        z
          .object({
            lamports: z.number(),
            owner: z.string(),
            executable: z.boolean(),
            data: z.array(z.string()),
          })
          .nullable(),
      )
      .nullable()
      .optional(),
    unitsConsumed: z.number().optional(),
    innerInstructions: z
      .array(
        z.object({
          index: z.number(),
          instructions: z.array(z.record(z.string(), z.unknown())),
        }),
      )
      .nullable()
      .optional(),
  }),
});

const jsonRpcSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

/** Implementation over @solana/web3.js. The only place that talks to the network. */
export class Web3RpcClient implements RpcClient {
  readonly #connection: Connection;
  readonly #url: string;
  readonly #commitment: Commitment;

  constructor(config: RpcConfig) {
    this.#url = config.rpcUrl;
    this.#commitment = config.commitment;
    // No silent retry on 429: the error must surface, not stall the loop.
    this.#connection = new Connection(config.rpcUrl, {
      commitment: config.commitment,
      disableRetryOnRateLimit: true,
    });
  }

  #fail(step: string, error: unknown): RpcResult<never> {
    const raw = error instanceof Error ? error.message : String(error);
    return { ok: false, failure: { step, message: redact(raw, this.#url) } };
  }

  async identifyNetwork(): Promise<RpcResult<string>> {
    try {
      return { ok: true, value: await this.#connection.getGenesisHash() };
    } catch (error) {
      return this.#fail("identifyNetwork", error);
    }
  }

  async readAccounts(
    addresses: readonly string[],
  ): Promise<RpcResult<AccountsRead>> {
    if (addresses.length === 0)
      return { ok: true, value: { slot: 0, accounts: [] } };
    try {
      const keys = addresses.map((a) => new PublicKey(a));
      const response = await this.#connection.getMultipleAccountsInfoAndContext(
        keys,
        {
          commitment: this.#commitment,
        },
      );
      if (response.value.length !== addresses.length) {
        return {
          ok: false,
          failure: {
            step: "readAccounts",
            message: `RPC returned ${response.value.length} accounts for ${addresses.length} requested`,
          },
        };
      }
      const accounts = addresses.map((address, i) =>
        onChainState(address, response.value[i] ?? null),
      );
      return { ok: true, value: { slot: response.context.slot, accounts } };
    } catch (error) {
      return this.#fail("readAccounts", error);
    }
  }

  async simulate(
    tx: VersionedTransaction,
    options: SimulationOptions,
  ): Promise<RpcResult<SimulationResponse>> {
    const requested = [...options.accounts];

    // A v1 transaction cannot be re-serialized by this SDK, so the caller's
    // original bytes are used when available and serialization is only
    // attempted as a fallback.
    let encoded = options.rawTransactionBase64 ?? null;
    if (encoded === null) {
      try {
        encoded = Buffer.from(tx.serialize()).toString("base64");
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          failure: {
            step: "simulate",
            message: `could not encode the transaction (${raw}). Pass rawTransactionBase64 for a version 1 transaction.`,
          },
        };
      }
    }

    const config: Record<string, unknown> = {
      sigVerify: false, // the tx is not signed yet: that is the whole point
      replaceRecentBlockhash: true,
      commitment: this.#commitment,
      encoding: "base64",
      accounts: { encoding: "base64", addresses: requested },
    };
    if (options.minContextSlot !== undefined)
      config["minContextSlot"] = options.minContextSlot;
    if (options.innerInstructions === true) config["innerInstructions"] = true;

    let payload: unknown;
    try {
      const response = await fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "simulateTransaction",
          params: [encoded, config],
        }),
      });
      if (!response.ok) {
        return {
          ok: false,
          failure: {
            step: "simulate",
            message: `${response.status} ${response.statusText}`,
          },
        };
      }
      payload = await response.json();
    } catch (error) {
      return this.#fail("simulate", error);
    }

    const envelope = jsonRpcSchema.safeParse(payload);
    if (!envelope.success) {
      return {
        ok: false,
        failure: { step: "simulate", message: "RPC reply is not JSON-RPC" },
      };
    }
    if (envelope.data.error !== undefined) {
      return {
        ok: false,
        failure: {
          step: "simulate",
          message: redact(envelope.data.error.message, this.#url),
        },
      };
    }
    const parsed = simulateResponseSchema.safeParse(envelope.data.result);
    if (!parsed.success) {
      return {
        ok: false,
        failure: {
          step: "simulate",
          message: `unexpected simulateTransaction shape: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        },
      };
    }

    const value = parsed.data.value;
    const accounts: (AccountState | null)[] = [];
    const rawAccounts = value.accounts;
    if (rawAccounts !== undefined && rawAccounts !== null) {
      if (rawAccounts.length !== requested.length) {
        return {
          ok: false,
          failure: {
            step: "simulate",
            message: `post-state with ${rawAccounts.length} accounts for ${requested.length} requested`,
          },
        };
      }
      for (let i = 0; i < requested.length; i++) {
        const converted = simulatedState(
          requested[i] ?? "",
          rawAccounts[i] ?? null,
        );
        if (!converted.ok) return converted;
        accounts.push(converted.value);
      }
    }

    return {
      ok: true,
      value: {
        slot: parsed.data.context.slot,
        error:
          value.err === null || value.err === undefined
            ? null
            : JSON.stringify(value.err),
        unitsConsumed: value.unitsConsumed ?? null,
        logs: value.logs ?? null,
        requestedAccounts: requested,
        accounts,
        innerInstructions: normaliseInnerInstructions(value.innerInstructions),
      },
    };
  }

  /**
   * Parallel on purpose: resolving lookup tables is the extra call VETO makes
   * before signing, because `meta.loadedAddresses` only exists after
   * execution. Run serially, N tables would be N round trips inside the
   * decision's latency budget.
   */
  async readLookupTables(
    addresses: readonly string[],
  ): Promise<RpcResult<LookupTableRead>> {
    const results = await Promise.all(
      addresses.map(async (address): Promise<RpcResult<LookupTable>> => {
        try {
          const response = await this.#connection.getAddressLookupTable(
            new PublicKey(address),
            {
              commitment: this.#commitment,
            },
          );
          if (response.value === null) {
            return {
              ok: false,
              failure: {
                step: "readLookupTables",
                message: `table ${address} does not exist`,
              },
            };
          }
          return {
            ok: true,
            value: {
              table: address,
              addresses: response.value.state.addresses.map((a) =>
                a.toBase58(),
              ),
            },
          };
        } catch (error) {
          // An account that exists but is not a lookup table makes the SDK's
          // deserializer throw. The raw message tells the reader nothing.
          const raw = error instanceof Error ? error.message : String(error);
          return {
            ok: false,
            failure: {
              step: "readLookupTables",
              message: `${address} is not a valid Address Lookup Table (${redact(raw, this.#url)})`,
            },
          };
        }
      }),
    );
    const tables: LookupTable[] = [];
    const unresolved: { table: string; reason: string }[] = [];
    addresses.forEach((address, i) => {
      const r = results[i];
      if (r === undefined) return;
      if (r.ok) tables.push(r.value);
      else unresolved.push({ table: address, reason: r.failure.message });
    });
    return { ok: true, value: { tables, unresolved } };
  }
}

export function createRpcClient(config: RpcConfig): RpcClient {
  return new Web3RpcClient(config);
}
