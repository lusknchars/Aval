/**
 * The stake account decoder and the effects it produces, on bytes assembled
 * offset by offset from the program's own layout. A real mainnet account is
 * checked against the RPC's parser in `stake-real.test.ts` when one has been
 * recorded; this file is the layout itself.
 */
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { diffAccounts, type DiffInput } from "../../src/normalization/diff.js";
import {
  decodeStakeAccount,
  STAKE_ACCOUNT_SIZE,
  STAKE_PROGRAM_ID,
} from "../../src/normalization/stake.js";
import type { AccountState } from "../../src/normalization/rpc.js";

const STAKER = new PublicKey("9DwkxFA219HX4AGywf13T8c9j9MPzw7xACzERLUXF5HL");
const WITHDRAWER = new PublicKey("BfwiJ8thDzWHZX3KvArCDBdv1uCxh1F8x5p9PX4DJ3Td");
const CUSTODIAN = new PublicKey("11111111111111111111111111111111");
const VOTER = new PublicKey("J1to1yufRnoWn81KYg1XkTWzmKjnYSnmE2VY8DGUJ9Qv");
const THIEF = new PublicKey("AJ54F1RepD2hs4Ppky8DURWfikQoZdUkNTZ2QwUnSHVN");

interface Fields {
  readonly state: 0 | 1 | 2 | 3;
  readonly staker?: PublicKey;
  readonly withdrawer?: PublicKey;
  readonly custodian?: PublicKey;
  readonly stake?: bigint;
  readonly deactivationEpoch?: bigint;
}

/** Bytes laid out exactly as the program stores them. */
function stakeBytes(fields: Fields): Buffer {
  const data = Buffer.alloc(STAKE_ACCOUNT_SIZE);
  data.writeUInt32LE(fields.state, 0);
  data.writeBigUInt64LE(2_282_880n, 4);
  (fields.staker ?? STAKER).toBuffer().copy(data, 12);
  (fields.withdrawer ?? WITHDRAWER).toBuffer().copy(data, 44);
  data.writeBigInt64LE(0n, 76);
  data.writeBigUInt64LE(0n, 84);
  (fields.custodian ?? CUSTODIAN).toBuffer().copy(data, 92);
  if (fields.state === 2) {
    VOTER.toBuffer().copy(data, 124);
    data.writeBigUInt64LE(fields.stake ?? 5_000_000_000n, 156);
    data.writeBigUInt64LE(700n, 164);
    data.writeBigUInt64LE(fields.deactivationEpoch ?? 18_446_744_073_709_551_615n, 172);
    data.writeDoubleLE(0.25, 180);
    data.writeBigUInt64LE(123n, 188);
  }
  return data;
}

const ADDRESS = "StakeAcct111111111111111111111111111111111";

function state(data: Buffer, lamports = 5_002_282_880n): AccountState {
  return {
    address: ADDRESS,
    lamports,
    owner: STAKE_PROGRAM_ID,
    data,
    executable: false,
    lamportsExact: true,
  };
}

describe("decoding a stake account", () => {
  it("reads the authorities, the lockup and the delegation", () => {
    const decoded = decodeStakeAccount(stakeBytes({ state: 2 }), STAKE_PROGRAM_ID);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.state).toBe("stake");
    expect(decoded.value.staker).toBe(STAKER.toBase58());
    expect(decoded.value.withdrawer).toBe(WITHDRAWER.toBase58());
    expect(decoded.value.lockup.custodian).toBe(CUSTODIAN.toBase58());
    expect(decoded.value.rentExemptReserve).toBe(2_282_880n);
    expect(decoded.value.delegation).toEqual({
      voter: VOTER.toBase58(),
      stake: 5_000_000_000n,
      activationEpoch: 700n,
      deactivationEpoch: 18_446_744_073_709_551_615n,
    });
  });

  it("has no delegation in the initialized state", () => {
    const decoded = decodeStakeAccount(stakeBytes({ state: 1 }), STAKE_PROGRAM_ID);
    expect(decoded.ok && decoded.value.state).toBe("initialized");
    expect(decoded.ok && decoded.value.delegation).toBeNull();
  });

  it("refuses the wrong owner, the wrong size and an unknown state", () => {
    expect(decodeStakeAccount(stakeBytes({ state: 2 }), "11111111111111111111111111111111").ok).toBe(false);
    expect(decodeStakeAccount(Buffer.alloc(100), STAKE_PROGRAM_ID).ok).toBe(false);
    const bad = stakeBytes({ state: 2 });
    bad.writeUInt32LE(9, 0);
    expect(decodeStakeAccount(bad, STAKE_PROGRAM_ID).ok).toBe(false);
  });
});

describe("what a stake account's changes become", () => {
  const address = ADDRESS;
  const input = (before: Buffer, after: Buffer, lamportsAfter?: bigint): DiffInput => ({
    accounts: [
      { index: 0, address, writable: true, signer: false, source: "static", table: null },
    ],
    before: new Map([[address, state(before)]]),
    after: new Map([[address, state(after, lamportsAfter)]]),
    feePayer: "Payer1111111111111111111111111111111111111",
    fee: null,
    invokedPrograms: [],
  });

  it("names the withdrawer moving to somebody else -- the theft shape", () => {
    const effects = diffAccounts(
      input(stakeBytes({ state: 2 }), stakeBytes({ state: 2, withdrawer: THIEF })),
    );
    expect(effects).toEqual([
      {
        type: "AUTHORITY_CHANGE",
        account: address,
        authorityKind: "withdrawer",
        counterparty: THIEF.toBase58(),
      },
    ]);
  });

  it("names the staker and the custodian separately", () => {
    const effects = diffAccounts(
      input(
        stakeBytes({ state: 2 }),
        stakeBytes({ state: 2, staker: THIEF, custodian: THIEF }),
      ),
    );
    expect(effects.map((e) => e.authorityKind).sort()).toEqual(["custodian", "staker"]);
  });

  it("produces nothing for a deactivate: no authority moved, no lamports moved", () => {
    const effects = diffAccounts(
      input(stakeBytes({ state: 2 }), stakeBytes({ state: 2, deactivationEpoch: 800n })),
    );
    expect(effects).toEqual([]);
  });

  it("does not treat initialising as an authority handover", () => {
    const effects = diffAccounts(input(stakeBytes({ state: 0 }), stakeBytes({ state: 1 })));
    expect(effects.filter((e) => e.type === "AUTHORITY_CHANGE")).toEqual([]);
  });

  it("still reads a withdrawal as lamports leaving", () => {
    const effects = diffAccounts(
      input(stakeBytes({ state: 2 }), stakeBytes({ state: 2 }), 2_282_880n),
    );
    expect(effects).toEqual([
      { type: "BALANCE_DECREASE", account: address, mint: "SOL", amount: 5_000_000_000n },
    ]);
  });
});
