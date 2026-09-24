/**
 * Resolving the accounts a transaction touches, before it is signed.
 *
 * This is where VETO pays a price the chain does not: after execution, the RPC
 * hands back `meta.loadedAddresses` and every account is visible. Before
 * signing, addresses that came from an Address Lookup Table are just indexes.
 * They have to be resolved with an extra round trip, or the destination of a
 * DeFi transaction stays invisible to the evaluation.
 *
 * The account order is the runtime's, and instruction indexes depend on it:
 * static keys, then every writable entry across all lookup tables, then every
 * readonly one.
 */
import type { MessageV0, VersionedMessage } from "@solana/web3.js";
import type { RpcClient, RpcResult } from "./rpc.js";

export interface ResolvedAccount {
  /** Position in the runtime's account list. Instruction indexes point here. */
  readonly index: number;
  readonly address: string;
  readonly signer: boolean;
  /**
   * Writable as DECLARED in the message. The runtime may demote an account,
   * so this is an upper bound on what can change, never a lower one.
   */
  readonly writable: boolean;
  readonly source: "static" | "lookup";
  /** Which lookup table it came from, for the alert message. */
  readonly table: { readonly address: string; readonly index: number } | null;
}

export interface AccountResolution {
  readonly accounts: readonly ResolvedAccount[];
  /**
   * Accounts whose post-state must be requested from the simulation.
   *
   * Only the writable ones: a readonly account cannot change state, so asking
   * for it would spend latency to learn nothing. This is what keeps a DeFi
   * transaction from requesting 256 accounts.
   */
  readonly toObserve: readonly string[];
  /**
   * Lookup tables that could not be read. Their accounts are missing from the
   * list above, which means the evaluation is running partially blind. This
   * must become a coverage finding -- never silence.
   */
  readonly unresolvedTables: readonly {
    readonly table: string;
    readonly reason: string;
  }[];
}

function hasLookups(message: VersionedMessage): message is MessageV0 {
  return message.addressTableLookups.length > 0;
}

/**
 * Signer and writable from position plus header. The message orders static
 * keys as: writable signers, readonly signers, writable non-signers, readonly
 * non-signers.
 */
function staticAccounts(message: VersionedMessage): ResolvedAccount[] {
  const {
    numRequiredSignatures,
    numReadonlySignedAccounts,
    numReadonlyUnsignedAccounts,
  } = message.header;
  const keys = message.staticAccountKeys;
  return keys.map((key, index) => {
    const signer = index < numRequiredSignatures;
    const writable = signer
      ? index < numRequiredSignatures - numReadonlySignedAccounts
      : index < keys.length - numReadonlyUnsignedAccounts;
    return {
      index,
      address: key.toBase58(),
      signer,
      writable,
      source: "static",
      table: null,
    };
  });
}

/**
 * Resolves every account a message references.
 *
 * A message with no lookup tables needs no network at all -- the whole list is
 * already in the message.
 */
export async function resolveAccounts(
  message: VersionedMessage,
  rpc: RpcClient,
): Promise<RpcResult<AccountResolution>> {
  const accounts = staticAccounts(message);
  const unresolvedTables: { table: string; reason: string }[] = [];

  if (hasLookups(message)) {
    const lookups = message.addressTableLookups;
    const read = await rpc.readLookupTables(
      lookups.map((l) => l.accountKey.toBase58()),
    );
    if (!read.ok) return read;

    const byAddress = new Map(
      read.value.tables.map((t) => [t.table, t.addresses]),
    );
    for (const u of read.value.unresolved)
      unresolvedTables.push({ table: u.table, reason: u.reason });

    // Runtime order: all writable entries first, then all readonly ones.
    const collect = (writable: boolean): void => {
      for (const lookup of lookups) {
        const table = lookup.accountKey.toBase58();
        const indexes = writable
          ? lookup.writableIndexes
          : lookup.readonlyIndexes;
        const contents = byAddress.get(table);
        for (const indexInTable of indexes) {
          if (contents === undefined) {
            // The table failed to read: the account exists in the transaction
            // but its address is unknown. Recorded, not invented.
            unresolvedTables.push({
              table,
              reason: `index ${indexInTable} could not be resolved`,
            });
            continue;
          }
          const address = contents[indexInTable];
          if (address === undefined) {
            unresolvedTables.push({
              table,
              reason: `index ${indexInTable} is out of range for a table with ${contents.length} entries`,
            });
            continue;
          }
          accounts.push({
            index: accounts.length,
            address,
            signer: false, // a lookup table can never carry a signer
            writable,
            source: "lookup",
            table: { address: table, index: indexInTable },
          });
        }
      }
    };
    collect(true);
    collect(false);
  }

  const toObserve = [
    ...new Set(accounts.filter((a) => a.writable).map((a) => a.address)),
  ];
  return { ok: true, value: { accounts, toObserve, unresolvedTables } };
}

/** Resolves an instruction's account index to an address, or says it could not. */
export function addressAt(
  accounts: readonly ResolvedAccount[],
  index: number,
): string | null {
  return accounts[index]?.address ?? null;
}

/** Programs invoked by the message's own instructions (CPI targets are not here). */
export function invokedProgramsOf(
  message: VersionedMessage,
  accounts: readonly ResolvedAccount[],
): readonly string[] {
  const programs = new Set<string>();
  for (const instruction of message.compiledInstructions) {
    const address = addressAt(accounts, instruction.programIdIndex);
    if (address !== null) programs.add(address);
  }
  return [...programs];
}
