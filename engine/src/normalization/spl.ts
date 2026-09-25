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
import { ExtensionType } from "@solana/spl-token";
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

/**
 * Token-2022 extensions, read far enough to tell danger from decoration.
 *
 * After the base layout the program appends a TLV list: one byte of account
 * type at offset 165, then entries of `u16 type, u16 length, value`. Mints
 * are padded to the account size first, so both start at the same place.
 *
 * Only the TYPE ids are read, never the values. That is enough to answer the
 * one question that matters -- is there something here that could move the
 * tokens without showing up as an effect -- and it keeps this a few lines of
 * offset arithmetic rather than a second decoder.
 *
 * The list below is an ALLOWLIST of extensions that are harmless for that
 * question, and everything else is reported, including ids this code has
 * never heard of. New extension types get added to the program over time;
 * treating an unknown one as harmless is precisely how a detector goes quiet
 * on the attack it was built for.
 */
const ACCOUNT_TYPE_OFFSET = TOKEN_ACCOUNT_SIZE;
const TLV_START = ACCOUNT_TYPE_OFFSET + 1;

/**
 * Extension ids and their names, taken from the token program's own enum.
 *
 * Not a hand-written table. The first version transcribed the numbers, and a
 * real mainnet account came back carrying id 27, which that table did not
 * have -- it is `PausableAccount`. Numbers copied by hand go stale the moment
 * the program adds one, and this is a dependency already installed.
 */
const NAME_BY_ID: ReadonlyMap<number, string> = new Map(
  Object.entries(ExtensionType)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([name, id]) => [id, name]),
);

/**
 * Extensions that cannot hide anything VETO needs.
 *
 * An ALLOWLIST, never a blocklist of the dangerous: new types get added to
 * the program over time, and assuming an unknown one is harmless is precisely
 * how a detector goes quiet on the thing it was built for.
 *
 * Two questions decide membership. Can it let somebody move or freeze the
 * tokens? And does it change the relationship between the RAW amount, which
 * is what the diff reads, and the displayed amount, which is what a human
 * types into a tool call? A yes to either keeps it out.
 *
 * That second question is why `InterestBearingConfig` and
 * `ScaledUiAmountConfig` are absent despite being harmless in every other
 * sense: the magnitude check converts "100" into raw units using the mint's
 * decimals, and under either of those the conversion is silently wrong.
 *
 * A transfer fee stays in, because both sides of it are observed -- the payer
 * loses and the recipient gains, and the gap is already in the diff.
 */
const BENIGN_EXTENSIONS: ReadonlySet<string> = new Set([
  "TransferFeeConfig",
  "TransferFeeAmount",
  "ImmutableOwner",
  "MemoTransfer",
  "CpiGuard",
  "MetadataPointer",
  "TokenMetadata",
  "GroupPointer",
  "TokenGroup",
  "GroupMemberPointer",
  "TokenGroupMember",
]);

/**
 * Which of the two layouts an extended Token-2022 account holds.
 *
 * A mint with extensions is PADDED to the size of a token account before its
 * extension list starts, so length alone cannot tell the two apart. Reading a
 * mint through the token layout takes its supply for an owner and its
 * authority bytes for a delegate -- and since a supply change alters bytes
 * inside the token layout's owner field, minting produced a phantom
 * OWNER_CHANGE with a fabricated address, reported as critical. A wrong
 * confident answer, which is worse than no answer.
 *
 * null means there is no discriminator, so the buffer is a plain base layout.
 */
export function extendedAccountType(
  data: Buffer,
): "account" | "mint" | "unknown" | null {
  if (data.length <= TOKEN_ACCOUNT_SIZE) return null;
  const byte = data.readUInt8(ACCOUNT_TYPE_OFFSET);
  if (byte === 1) return "account";
  if (byte === 2) return "mint";
  return "unknown";
}

/**
 * Extensions on this account that VETO cannot see through, by name.
 *
 * Empty means either no extensions at all or only harmless ones -- and that
 * distinction is the whole point: reporting every Token-2022 account made
 * every legitimate transfer of such a token produce a finding, measured on
 * real mainnet traffic.
 */
export function opaqueExtensionsOf(
  ownerProgram: string,
  data: Buffer,
): readonly string[] {
  if (!isTokenProgram(ownerProgram)) return [];
  if (data.length <= TLV_START) return [];

  const found: string[] = [];
  let offset = TLV_START;
  while (offset + 4 <= data.length) {
    const type = data.readUInt16LE(offset);
    const length = data.readUInt16LE(offset + 2);
    // Type 0 is uninitialized: the end of the list, or zero padding.
    if (type === 0) break;
    const next = offset + 4 + length;
    if (next > data.length) {
      // The list runs past the buffer. Stop, and say so: a malformed tail is
      // a thing not read, which is exactly what this function reports.
      found.push("malformed_extension_list");
      break;
    }
    offset = next;
    const name = NAME_BY_ID.get(type);
    if (name !== undefined && BENIGN_EXTENSIONS.has(name)) continue;
    found.push(name ?? `unknown_extension_${type}`);
  }
  return [...new Set(found)];
}

/**
 * Native programs whose account data carries AUTHORITY, and which VETO does
 * not decode.
 *
 * The account model is the reason this list has to exist at all. The diff
 * reports what it can read: lamports, and the fixed layout of a token account
 * or a mint. An account owned by anything else changes its bytes and produces
 * NO effect -- which reads, downstream, as "this transaction does nothing".
 *
 * For an AMM pool or an order book that is fine: the user's assets live in
 * token accounts, which are read. For these four it is not. A stake account
 * holds the staker and withdrawer authorities; the upgradeable loader holds
 * the authority that can replace a program's code outright. Handing either of
 * those away is exactly AUTHORITY_CHANGE, and none of it is visible in any
 * byte this project parses.
 */
const AUTHORITY_BEARING_PROGRAMS: ReadonlyMap<string, string> = new Map([
  ["Stake11111111111111111111111111111111111111", "stake"],
  ["Vote111111111111111111111111111111111111111", "vote"],
  ["BPFLoaderUpgradeab1e11111111111111111111111", "upgradeable_loader"],
  ["Config1111111111111111111111111111111111111", "config"],
]);

/** The program's short name when its state carries authority, else null. */
export function authorityBearingProgram(owner: string): string | null {
  return AUTHORITY_BEARING_PROGRAMS.get(owner) ?? null;
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
  // A longer buffer says which layout it holds. Refusing anything that is not
  // an account is the whole point: the base offsets would otherwise "decode"
  // a mint into a plausible-looking token account.
  const extended = extendedAccountType(data);
  if (extended !== null && extended !== "account") {
    return {
      ok: false,
      reason: `account type byte says "${extended}", not a token account`,
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
