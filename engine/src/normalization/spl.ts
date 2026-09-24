/**
 * Decoding SPL accounts straight from their bytes.
 *
 * This is the scope cut that makes the project tractable. The token account
 * layout is fixed and public, so `amount`, `owner`, `delegate` and
 * `delegatedAmount` come out of known offsets with no program IDL. A program
 * VETO has never seen, if it grants a delegate through the Token Program,
 * produces a readable delegate all the same.
 *
 * Everything here is PURE: bytes in, values out, no network, no exceptions.
 * A wrong size is a result, not a throw.
 */
import bs58 from "bs58";

/** Token account layout, in bytes. Same base for Token and Token-2022. */
export const TOKEN_ACCOUNT_SIZE = 165;
/** Mint layout, in bytes. */
export const MINT_SIZE = 82;

export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** u64::MAX. As a delegated amount it means unlimited allowance. */
export const UNLIMITED_ALLOWANCE = 18_446_744_073_709_551_615n;

/**
 * Offsets of the token account layout. Written out rather than derived so a
 * misreading is visible in review instead of hidden in arithmetic.
 */
const TOKEN = {
  mint: 0,
  owner: 32,
  amount: 64,
  delegateOption: 72,
  delegate: 76,
  state: 108,
  isNativeOption: 109,
  isNative: 113,
  delegatedAmount: 121,
  closeAuthorityOption: 129,
  closeAuthority: 133,
};

const MINT = {
  mintAuthorityOption: 0,
  mintAuthority: 4,
  supply: 36,
  decimals: 44,
  isInitialized: 45,
  freezeAuthorityOption: 46,
  freezeAuthority: 50,
};

export type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/** 0 uninitialized, 1 initialized, 2 frozen. Anything else is unknown. */
export type TokenAccountState =
  "uninitialized" | "initialized" | "frozen" | "unknown";

export interface TokenAccount {
  readonly mint: string;
  /** Who controls the tokens. NOT the account's owner program. */
  readonly owner: string;
  readonly amount: bigint;
  /** null when no delegate is set. */
  readonly delegate: string | null;
  readonly delegatedAmount: bigint;
  readonly state: TokenAccountState;
  /** Set for a wrapped SOL account: the rent-exempt reserve it holds. */
  readonly isNative: bigint | null;
  readonly closeAuthority: string | null;
  /** Which token program owns this account. */
  readonly program: "token" | "token-2022";
  /**
   * Token-2022 accounts carry extensions past the base 165 bytes. The base
   * fields above are still valid, but transfer fees, hooks and confidential
   * balances live in the extension area and are NOT decoded. The caller must
   * turn this into a coverage finding rather than assume full visibility.
   */
  readonly hasExtensions: boolean;
}

export interface Mint {
  readonly decimals: number;
  readonly supply: bigint;
  readonly mintAuthority: string | null;
  readonly freezeAuthority: string | null;
  readonly isInitialized: boolean;
  readonly program: "token" | "token-2022";
}

function publicKeyAt(data: Buffer, offset: number): string {
  return bs58.encode(data.subarray(offset, offset + 32));
}

/**
 * COption in the SPL layout: a 4-byte discriminator followed by the value.
 * 0 means absent, and an absent value must come back as null -- never as the
 * 32 zero bytes, which would read as a real address.
 */
function optionalKeyAt(
  data: Buffer,
  optionOffset: number,
  keyOffset: number,
): string | null {
  return data.readUInt32LE(optionOffset) === 0
    ? null
    : publicKeyAt(data, keyOffset);
}

function stateFrom(byte: number): TokenAccountState {
  switch (byte) {
    case 0:
      return "uninitialized";
    case 1:
      return "initialized";
    case 2:
      return "frozen";
    default:
      return "unknown";
  }
}

export function isTokenProgram(owner: string): boolean {
  return owner === TOKEN_PROGRAM_ID || owner === TOKEN_2022_PROGRAM_ID;
}

function programOf(owner: string): "token" | "token-2022" {
  return owner === TOKEN_2022_PROGRAM_ID ? "token-2022" : "token";
}

/**
 * Decodes a token account.
 *
 * `owner` is the account's owning PROGRAM, used to tell Token from Token-2022.
 * Note the name collision that trips everyone up: the owner *inside* the data
 * is who controls the tokens, and it is a different thing from the account's
 * owner program.
 */
export function decodeTokenAccount(
  data: Buffer,
  ownerProgram: string,
): DecodeResult<TokenAccount> {
  if (!isTokenProgram(ownerProgram)) {
    return {
      ok: false,
      reason: `account is not owned by a token program (owner ${ownerProgram})`,
    };
  }
  if (data.length < TOKEN_ACCOUNT_SIZE) {
    return {
      ok: false,
      reason: `token account needs ${TOKEN_ACCOUNT_SIZE} bytes, got ${data.length}`,
    };
  }

  const delegate = optionalKeyAt(data, TOKEN.delegateOption, TOKEN.delegate);
  return {
    ok: true,
    value: {
      mint: publicKeyAt(data, TOKEN.mint),
      owner: publicKeyAt(data, TOKEN.owner),
      amount: data.readBigUInt64LE(TOKEN.amount),
      delegate,
      // The delegated amount only means anything when a delegate is set.
      delegatedAmount:
        delegate === null ? 0n : data.readBigUInt64LE(TOKEN.delegatedAmount),
      state: stateFrom(data.readUInt8(TOKEN.state)),
      isNative:
        data.readUInt32LE(TOKEN.isNativeOption) === 0
          ? null
          : data.readBigUInt64LE(TOKEN.isNative),
      closeAuthority: optionalKeyAt(
        data,
        TOKEN.closeAuthorityOption,
        TOKEN.closeAuthority,
      ),
      program: programOf(ownerProgram),
      hasExtensions: data.length > TOKEN_ACCOUNT_SIZE,
    },
  };
}

export function decodeMint(
  data: Buffer,
  ownerProgram: string,
): DecodeResult<Mint> {
  if (!isTokenProgram(ownerProgram)) {
    return {
      ok: false,
      reason: `account is not owned by a token program (owner ${ownerProgram})`,
    };
  }
  if (data.length < MINT_SIZE) {
    return {
      ok: false,
      reason: `mint needs ${MINT_SIZE} bytes, got ${data.length}`,
    };
  }
  return {
    ok: true,
    value: {
      decimals: data.readUInt8(MINT.decimals),
      supply: data.readBigUInt64LE(MINT.supply),
      mintAuthority: optionalKeyAt(
        data,
        MINT.mintAuthorityOption,
        MINT.mintAuthority,
      ),
      freezeAuthority: optionalKeyAt(
        data,
        MINT.freezeAuthorityOption,
        MINT.freezeAuthority,
      ),
      isInitialized: data.readUInt8(MINT.isInitialized) === 1,
      program: programOf(ownerProgram),
    },
  };
}

/**
 * Unlimited allowance. The single strongest signal in the system: a delegate
 * that can move every token in the account, now and for as long as it stands.
 */
export function isUnlimitedAllowance(delegatedAmount: bigint): boolean {
  return delegatedAmount >= UNLIMITED_ALLOWANCE;
}

/**
 * Raw amount -> exact decimal string, never passing through a float.
 * Used for display and for comparing against a manifest's `decimal` unit.
 */
export function formatRawAmount(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

/** Decimal string -> raw amount. Refuses more decimal places than the mint has. */
export function parseDecimalAmount(
  text: string,
  decimals: number,
): DecodeResult<bigint> {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text.trim());
  if (match === null)
    return { ok: false, reason: `"${text}" is not a positive decimal number` };
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    return {
      ok: false,
      reason: `"${text}" has more precision than the mint's ${decimals} decimals`,
    };
  }
  return { ok: true, value: BigInt(whole + fraction.padEnd(decimals, "0")) };
}
