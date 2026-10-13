/**
 * The account list is the foundation of everything downstream.
 *
 * Every instruction refers to accounts by INDEX into one ordered list, and the
 * diff attributes each state change to whatever address sits at that index. An
 * off-by-one in the writable calculation means an account that changes is
 * never requested, and its effects are invisible. A mistake in the lookup-table
 * ordering means real effects attributed to the wrong addresses -- worse than
 * invisible, because it reads as confident and is wrong.
 *
 * So this file does not restate the rules. It compares our resolution against
 * the SDK's own independent implementation -- `isAccountWritable` and
 * `getAccountKeys` -- across many message shapes. Two implementations written
 * from the same spec agreeing is evidence; one implementation agreeing with
 * itself is not.
 */
import { describe, expect, it } from "vitest";
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  type AccountMeta,
  type MessageV0,
  type VersionedMessage,
} from "@solana/web3.js";
import { resolveAccounts } from "../../src/normalization/accounts.js";
import type {
  AccountsRead,
  LookupTableRead,
  RpcClient,
  RpcResult,
  SimulationResponse,
} from "../../src/normalization/rpc.js";

const FAKE_BLOCKHASH = PublicKey.default.toBase58();

function tableFor(
  key: PublicKey,
  addresses: PublicKey[],
): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key,
    state: {
      deactivationSlot: 2n ** 64n - 1n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses,
    },
  });
}

function rpcServing(table: AddressLookupTableAccount | null): RpcClient {
  return {
    readAccounts: async (): Promise<RpcResult<AccountsRead>> => ({
      ok: false,
      failure: { step: "readAccounts", message: "unused" },
    }),
    simulate: async (): Promise<RpcResult<SimulationResponse>> => ({
      ok: false,
      failure: { step: "simulate", message: "unused" },
    }),
    readLookupTables: async (): Promise<RpcResult<LookupTableRead>> => ({
      ok: true,
      value: {
        tables:
          table === null
            ? []
            : [
                {
                  table: table.key.toBase58(),
                  addresses: table.state.addresses.map((a) => a.toBase58()),
                },
              ],
        unresolved: [],
      },
    }),
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

interface Shape {
  readonly extraWritableSigners: number;
  readonly readonlySigners: number;
  readonly writableStatic: number;
  readonly readonlyStatic: number;
  readonly writableInTable: number;
  readonly readonlyInTable: number;
}

interface Built {
  readonly message: MessageV0;
  readonly table: AddressLookupTableAccount | null;
}

/**
 * One message per shape, compiled by the SDK so the header and the lookup
 * indexes are whatever the wire format really says -- not what we think it
 * says.
 */
function build(shape: Shape): Built {
  const payer = Keypair.generate();
  const keys: AccountMeta[] = [];

  for (let i = 0; i < shape.extraWritableSigners; i++)
    keys.push({
      pubkey: Keypair.generate().publicKey,
      isSigner: true,
      isWritable: true,
    });
  for (let i = 0; i < shape.readonlySigners; i++)
    keys.push({
      pubkey: Keypair.generate().publicKey,
      isSigner: true,
      isWritable: false,
    });
  for (let i = 0; i < shape.writableStatic; i++)
    keys.push({
      pubkey: Keypair.generate().publicKey,
      isSigner: false,
      isWritable: true,
    });
  for (let i = 0; i < shape.readonlyStatic; i++)
    keys.push({
      pubkey: Keypair.generate().publicKey,
      isSigner: false,
      isWritable: false,
    });

  // These live in the lookup table, so the compiler moves them out of the
  // static keys and into indexes.
  const inTable: PublicKey[] = [];
  for (let i = 0; i < shape.writableInTable; i++) {
    const pubkey = Keypair.generate().publicKey;
    inTable.push(pubkey);
    keys.push({ pubkey, isSigner: false, isWritable: true });
  }
  for (let i = 0; i < shape.readonlyInTable; i++) {
    const pubkey = Keypair.generate().publicKey;
    inTable.push(pubkey);
    keys.push({ pubkey, isSigner: false, isWritable: false });
  }

  const table =
    inTable.length === 0
      ? null
      : tableFor(Keypair.generate().publicKey, [
          // Padding first, so the indexes used are never simply 0,1,2 -- an
          // off-by-one in the table lookup would otherwise still line up.
          Keypair.generate().publicKey,
          Keypair.generate().publicKey,
          ...inTable,
        ]);

  const instruction = new TransactionInstruction({
    programId: SystemProgram.programId,
    keys,
    data: Buffer.alloc(0),
  });
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: FAKE_BLOCKHASH,
    instructions: [instruction],
  }).compileToV0Message(table === null ? [] : [table]);

  return { message, table };
}

const SHAPES: readonly Shape[] = [
  {
    extraWritableSigners: 0,
    readonlySigners: 0,
    writableStatic: 1,
    readonlyStatic: 0,
    writableInTable: 0,
    readonlyInTable: 0,
  },
  {
    extraWritableSigners: 0,
    readonlySigners: 0,
    writableStatic: 2,
    readonlyStatic: 3,
    writableInTable: 0,
    readonlyInTable: 0,
  },
  {
    extraWritableSigners: 2,
    readonlySigners: 2,
    writableStatic: 2,
    readonlyStatic: 2,
    writableInTable: 0,
    readonlyInTable: 0,
  },
  {
    extraWritableSigners: 0,
    readonlySigners: 0,
    writableStatic: 1,
    readonlyStatic: 1,
    writableInTable: 3,
    readonlyInTable: 0,
  },
  {
    extraWritableSigners: 0,
    readonlySigners: 0,
    writableStatic: 1,
    readonlyStatic: 1,
    writableInTable: 0,
    readonlyInTable: 4,
  },
  {
    extraWritableSigners: 1,
    readonlySigners: 1,
    writableStatic: 2,
    readonlyStatic: 2,
    writableInTable: 3,
    readonlyInTable: 5,
  },
  {
    extraWritableSigners: 3,
    readonlySigners: 0,
    writableStatic: 0,
    readonlyStatic: 0,
    writableInTable: 7,
    readonlyInTable: 9,
  },
];

describe("a lookup table that cannot be read", () => {
  /** Serves nothing, and says why. */
  function rpcWithMissingTable(key: string): RpcClient {
    return {
      readAccounts: async (): Promise<RpcResult<AccountsRead>> => ({
        ok: false,
        failure: { step: "readAccounts", message: "unused" },
      }),
      simulate: async (): Promise<RpcResult<SimulationResponse>> => ({
        ok: false,
        failure: { step: "simulate", message: "unused" },
      }),
      readLookupTables: async (): Promise<RpcResult<LookupTableRead>> => ({
        ok: true,
        value: {
          tables: [],
          unresolved: [{ table: key, reason: "table does not exist" }],
        },
      }),
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

  it("never hands back a list whose indexes have shifted", async () => {
    // An account skipped because its table could not be read used to shorten
    // the list, which moved every later index down by one. Instruction
    // account indexes point into that list, so the effects that WERE produced
    // were attributed to the wrong addresses -- confidently. Worse than
    // silence, and the same failure mode as reading a mint through the token
    // layout.
    const shape: Shape = {
      extraWritableSigners: 0,
      readonlySigners: 0,
      writableStatic: 1,
      readonlyStatic: 1,
      writableInTable: 3,
      readonlyInTable: 2,
    };
    const { message, table } = build(shape);
    if (table === null) throw new Error("expected a lookup table");

    const resolved = await resolveAccounts(
      message,
      rpcWithMissingTable(table.key.toBase58()),
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.failure.message).toContain("could not be resolved");
  });
});

describe("an instruction index that does not exist", () => {
  it("refuses instead of letting the program vanish", async () => {
    // A program index nothing resolves used to drop out of the invoked
    // programs silently -- so a manifest's program allowlist had nothing to
    // reject, and an unknown program reads as no program at all.
    const shape: Shape = {
      extraWritableSigners: 0,
      readonlySigners: 0,
      writableStatic: 1,
      readonlyStatic: 0,
      writableInTable: 0,
      readonlyInTable: 0,
    };
    const { message } = build(shape);
    const beyond = message.staticAccountKeys.length + 5;
    const broken: VersionedMessage = Object.create(
      Object.getPrototypeOf(message),
      {
        ...Object.getOwnPropertyDescriptors(message),
        compiledInstructions: {
          value: [
            { programIdIndex: beyond, accountKeyIndexes: [], data: new Uint8Array() },
          ],
          enumerable: true,
        },
      },
    );
    const resolved = await resolveAccounts(broken, rpcServing(null));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.failure.message).toContain(`account index ${beyond}`);
  });
});

describe("our account list and the SDK's", () => {
  it("agree on the order of every address", async () => {
    for (const shape of SHAPES) {
      const { message, table } = build(shape);
      const resolved = await resolveAccounts(message, rpcServing(table));
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;

      const sdk = message
        .getAccountKeys({
          addressLookupTableAccounts: table === null ? [] : [table],
        })
        .keySegments()
        .flat()
        .map((k) => k.toBase58());

      expect(resolved.value.accounts.map((a) => a.address)).toEqual(sdk);
      // And the index we record has to BE the position, because instruction
      // account indexes are resolved through it.
      resolved.value.accounts.forEach((account, i) => {
        expect(account.index).toBe(i);
      });
    }
  });

  it("agree on which accounts are writable, index by index", async () => {
    for (const shape of SHAPES) {
      const { message, table } = build(shape);
      const resolved = await resolveAccounts(message, rpcServing(table));
      if (!resolved.ok) return;

      const ours = resolved.value.accounts.map((a) => a.writable);
      const theirs = resolved.value.accounts.map((_, i) =>
        message.isAccountWritable(i),
      );
      expect(ours).toEqual(theirs);
    }
  });

  it("agree on which accounts are signers", async () => {
    for (const shape of SHAPES) {
      const { message, table } = build(shape);
      const resolved = await resolveAccounts(message, rpcServing(table));
      if (!resolved.ok) return;

      const ours = resolved.value.accounts.map((a) => a.signer);
      const theirs = resolved.value.accounts.map((_, i) =>
        message.isAccountSigner(i),
      );
      expect(ours).toEqual(theirs);
    }
  });

  it("observes exactly the writable accounts, deduplicated", async () => {
    for (const shape of SHAPES) {
      const { message, table } = build(shape);
      const resolved = await resolveAccounts(message, rpcServing(table));
      if (!resolved.ok) return;

      const expected = [
        ...new Set(
          resolved.value.accounts
            .filter((_, i) => message.isAccountWritable(i))
            .map((a) => a.address),
        ),
      ];
      expect(resolved.value.toObserve).toEqual(expected);
    }
  });
});
