/**
 * The stake account, read from its bytes.
 *
 * Until this file existed a stake account was an "authority-bearing program
 * AVAL does not decode": any change to its bytes was reported as an opaque
 * change, and the one thing that matters -- the WITHDRAWER authority moving
 * to somebody else, which is how stake gets stolen -- looked exactly like an
 * ordinary deactivate. Both are "the data changed".
 *
 * The layout is fixed (StakeStateV2, 200 bytes), which is what makes this
 * safe to read the same way a token account is read: offsets, not an IDL.
 *
 *   0    u32  state: 0 uninitialized, 1 initialized, 2 stake, 3 rewards pool
 *   4    u64  meta.rent_exempt_reserve
 *   12   [32] meta.authorized.staker
 *   44   [32] meta.authorized.withdrawer
 *   76   i64  meta.lockup.unix_timestamp
 *   84   u64  meta.lockup.epoch
 *   92   [32] meta.lockup.custodian
 *   124  [32] stake.delegation.voter_pubkey          (state 2 only)
 *   156  u64  stake.delegation.stake
 *   164  u64  stake.delegation.activation_epoch
 *   172  u64  stake.delegation.deactivation_epoch
 *   180  f64  stake.delegation.warmup_cooldown_rate  (deprecated, unread)
 *   188  u64  stake.credits_observed
 *   196  u8   stake_flags
 *
 * No new effect type. Authorities changing is AUTHORITY_CHANGE; lamports
 * leaving is BALANCE_DECREASE, and the diff already reads lamports on every
 * account. What decoding adds is the ability to say WHICH authority moved,
 * and to stop calling a delegate or a deactivate "opaque".
 */
import bs58 from "bs58";

export const STAKE_PROGRAM_ID = "Stake11111111111111111111111111111111111111";
export const STAKE_ACCOUNT_SIZE = 200;

const OFFSET = {
  state: 0,
  rentExemptReserve: 4,
  staker: 12,
  withdrawer: 44,
  lockupTimestamp: 76,
  lockupEpoch: 84,
  custodian: 92,
  voter: 124,
  stake: 156,
  activationEpoch: 164,
  deactivationEpoch: 172,
  creditsObserved: 188,
};

export type StakeState = "uninitialized" | "initialized" | "stake" | "rewards_pool";

export interface StakeDelegation {
  readonly voter: string;
  readonly stake: bigint;
  readonly activationEpoch: bigint;
  readonly deactivationEpoch: bigint;
}

export interface StakeAccount {
  readonly state: StakeState;
  readonly rentExemptReserve: bigint;
  readonly staker: string;
  readonly withdrawer: string;
  readonly lockup: {
    readonly unixTimestamp: bigint;
    readonly epoch: bigint;
    readonly custodian: string;
  };
  /** Present only in the `stake` state. */
  readonly delegation: StakeDelegation | null;
}

export type StakeDecodeResult =
  | { readonly ok: true; readonly value: StakeAccount }
  | { readonly ok: false; readonly reason: string };

const STATES: readonly StakeState[] = [
  "uninitialized",
  "initialized",
  "stake",
  "rewards_pool",
];

function keyAt(data: Buffer, offset: number): string {
  return bs58.encode(data.subarray(offset, offset + 32));
}

export function isStakeProgram(owner: string): boolean {
  return owner === STAKE_PROGRAM_ID;
}

export function decodeStakeAccount(
  data: Buffer,
  ownerProgram: string,
): StakeDecodeResult {
  if (!isStakeProgram(ownerProgram))
    return {
      ok: false,
      reason: `account is not owned by the stake program (owner ${ownerProgram})`,
    };
  if (data.length < STAKE_ACCOUNT_SIZE)
    return {
      ok: false,
      reason: `stake account needs ${STAKE_ACCOUNT_SIZE} bytes, got ${data.length}`,
    };

  const stateIndex = data.readUInt32LE(OFFSET.state);
  const state = STATES[stateIndex];
  if (state === undefined)
    return { ok: false, reason: `unknown stake state ${stateIndex}` };

  // An uninitialized account carries no meta worth reading: the bytes are
  // zero, and reporting "the withdrawer is the all-zero key" would be a
  // confident statement about nothing.
  if (state === "uninitialized")
    return {
      ok: true,
      value: {
        state,
        rentExemptReserve: 0n,
        staker: keyAt(data, OFFSET.staker),
        withdrawer: keyAt(data, OFFSET.withdrawer),
        lockup: { unixTimestamp: 0n, epoch: 0n, custodian: keyAt(data, OFFSET.custodian) },
        delegation: null,
      },
    };

  return {
    ok: true,
    value: {
      state,
      rentExemptReserve: data.readBigUInt64LE(OFFSET.rentExemptReserve),
      staker: keyAt(data, OFFSET.staker),
      withdrawer: keyAt(data, OFFSET.withdrawer),
      lockup: {
        unixTimestamp: data.readBigInt64LE(OFFSET.lockupTimestamp),
        epoch: data.readBigUInt64LE(OFFSET.lockupEpoch),
        custodian: keyAt(data, OFFSET.custodian),
      },
      delegation:
        state === "stake"
          ? {
              voter: keyAt(data, OFFSET.voter),
              stake: data.readBigUInt64LE(OFFSET.stake),
              activationEpoch: data.readBigUInt64LE(OFFSET.activationEpoch),
              deactivationEpoch: data.readBigUInt64LE(OFFSET.deactivationEpoch),
            }
          : null,
    },
  };
}
