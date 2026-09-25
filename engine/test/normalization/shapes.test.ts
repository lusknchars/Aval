/**
 * A matrix of transaction shapes, built rather than recorded.
 *
 * The recorded fixtures are six devnet scenarios, and sampling real mainnet
 * traffic mostly finds arbitrage. Neither covers the state transitions that
 * matter most and occur least: an account frozen, a mint authority handed
 * over, a delegate whose allowance merely grows, an account created and closed
 * inside one transaction. Those are exactly the cases an attacker reaches for,
 * so they cannot be left to whatever the chain happened to contain.
 *
 * Every state here is assembled byte by byte, so the transition under test is
 * the only thing that differs between before and after.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { diffAccounts } from "../../src/normalization/diff.js";
import {
  MINT_SIZE,
  TOKEN_ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  UNLIMITED_ALLOWANCE,
} from "../../src/normalization/spl.js";
import type { ResolvedAccount } from "../../src/normalization/accounts.js";
import type { AccountState } from "../../src/normalization/rpc.js";
import type { Effect, EffectType } from "../../src/types/effects.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

function address(): string {
  return Keypair.generate().publicKey.toBase58();
}

const MINT = address();
const OWNER = address();
const OTHER = address();
const ACCOUNT = address();

interface TokenFields {
  readonly mint?: string;
  readonly owner?: string;
  readonly amount?: bigint;
  readonly delegate?: string | null;
  readonly delegatedAmount?: bigint;
  readonly frozen?: boolean;
  readonly closeAuthority?: string | null;
  readonly program?: string;
  readonly lamports?: bigint;
}

/** A token account, assembled at the real offsets. */
function tokenAccount(fields: TokenFields = {}): AccountState {
  const data = Buffer.alloc(TOKEN_ACCOUNT_SIZE);
  const key = (base58: string): Buffer =>
    Buffer.from(new PublicKey(base58).toBytes());
  key(fields.mint ?? MINT).copy(data, 0);
  key(fields.owner ?? OWNER).copy(data, 32);
  data.writeBigUInt64LE(fields.amount ?? 0n, 64);
  const delegate = fields.delegate ?? null;
  data.writeUInt32LE(delegate === null ? 0 : 1, 72);
  if (delegate !== null) key(delegate).copy(data, 76);
  data.writeUInt8(fields.frozen === true ? 2 : 1, 108);
  data.writeUInt32LE(0, 109); // not native
  data.writeBigUInt64LE(fields.delegatedAmount ?? 0n, 121);
  const closeAuthority = fields.closeAuthority ?? null;
  data.writeUInt32LE(closeAuthority === null ? 0 : 1, 129);
  if (closeAuthority !== null) key(closeAuthority).copy(data, 133);
  return {
    address: ACCOUNT,
    lamports: fields.lamports ?? 2_039_280n,
    lamportsExact: true,
    owner: fields.program ?? TOKEN_PROGRAM_ID,
    executable: false,
    data,
  };
}

/** A mint, assembled at the real offsets. */
function mintAccount(
  mintAuthority: string | null,
  freezeAuthority: string | null,
): AccountState {
  const data = Buffer.alloc(MINT_SIZE);
  const key = (base58: string): Buffer =>
    Buffer.from(new PublicKey(base58).toBytes());
  data.writeUInt32LE(mintAuthority === null ? 0 : 1, 0);
  if (mintAuthority !== null) key(mintAuthority).copy(data, 4);
  data.writeBigUInt64LE(1_000n, 36);
  data.writeUInt8(6, 44);
  data.writeUInt8(1, 45);
  data.writeUInt32LE(freezeAuthority === null ? 0 : 1, 46);
  if (freezeAuthority !== null) key(freezeAuthority).copy(data, 50);
  return {
    address: ACCOUNT,
    lamports: 1_461_600n,
    lamportsExact: true,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    data,
  };
}

function systemAccount(lamports: bigint, owner = SYSTEM_PROGRAM): AccountState {
  return {
    address: ACCOUNT,
    lamports,
    lamportsExact: true,
    owner,
    executable: false,
    data: Buffer.alloc(0),
  };
}

/** One account, one transition, nothing else moving. */
function transition(
  before: AccountState | null,
  after: AccountState | null,
): readonly Effect[] {
  const accounts: readonly ResolvedAccount[] = [
    {
      index: 0,
      address: ACCOUNT,
      signer: false,
      writable: true,
      source: "static",
      table: null,
    },
  ];
  return diffAccounts({
    accounts,
    before: new Map([[ACCOUNT, before]]),
    after: new Map([[ACCOUNT, after]]),
    feePayer: "",
    fee: null,
    invokedPrograms: [],
  });
}

function types(effects: readonly Effect[]): readonly EffectType[] {
  return effects.map((e) => e.type);
}

describe("token balance transitions", () => {
  it("reports a decrease with the owner attached", () => {
    const effects = transition(
      tokenAccount({ amount: 1_000n }),
      tokenAccount({ amount: 400n }),
    );
    expect(types(effects)).toEqual(["BALANCE_DECREASE"]);
    expect(effects[0]?.amount).toBe(600n);
    expect(effects[0]?.owner).toBe(OWNER);
    expect(effects[0]?.counterparty).toBeUndefined();
  });

  it("reports an increase with the owner as the counterparty", () => {
    const effects = transition(
      tokenAccount({ amount: 400n }),
      tokenAccount({ amount: 1_000n }),
    );
    expect(effects[0]?.counterparty).toBe(OWNER);
    expect(effects[0]?.owner).toBe(OWNER);
  });

  it("says nothing when the balance does not move", () => {
    expect(transition(tokenAccount({ amount: 5n }), tokenAccount({ amount: 5n }))).toEqual(
      [],
    );
  });

  it("reports the full u64 range without losing precision", () => {
    const effects = transition(
      tokenAccount({ amount: UNLIMITED_ALLOWANCE }),
      tokenAccount({ amount: 0n }),
    );
    expect(effects[0]?.amount).toBe(UNLIMITED_ALLOWANCE);
  });
});

describe("delegate transitions", () => {
  it("reports a delegate that appears", () => {
    const effects = transition(
      tokenAccount({ amount: 100n }),
      tokenAccount({ amount: 100n, delegate: OTHER, delegatedAmount: 50n }),
    );
    expect(types(effects)).toEqual(["DELEGATE_GRANT"]);
    expect(effects[0]?.counterparty).toBe(OTHER);
    expect(effects[0]?.amount).toBe(50n);
  });

  it("reports an allowance that merely grows, with the same delegate", () => {
    // The quiet version: nobody new appears, the ceiling just moves.
    const effects = transition(
      tokenAccount({ delegate: OTHER, delegatedAmount: 10n }),
      tokenAccount({ delegate: OTHER, delegatedAmount: UNLIMITED_ALLOWANCE }),
    );
    expect(types(effects)).toEqual(["DELEGATE_GRANT"]);
    expect(effects[0]?.amount).toBe(UNLIMITED_ALLOWANCE);
  });

  it("reports a delegate swapped for a different one", () => {
    const effects = transition(
      tokenAccount({ delegate: OWNER, delegatedAmount: 10n }),
      tokenAccount({ delegate: OTHER, delegatedAmount: 10n }),
    );
    expect(types(effects)).toEqual(["DELEGATE_GRANT"]);
    expect(effects[0]?.counterparty).toBe(OTHER);
  });

  it("says nothing when an allowance shrinks", () => {
    // Less power than before is not a grant.
    expect(
      types(
        transition(
          tokenAccount({ delegate: OTHER, delegatedAmount: 100n }),
          tokenAccount({ delegate: OTHER, delegatedAmount: 1n }),
        ),
      ),
    ).toEqual([]);
  });

  it("says nothing when a delegate is removed", () => {
    // A revoke produces no effect in the closed vocabulary. Deliberate, and
    // the reason `revoke`'s manifest is entirely about what must NOT happen.
    expect(
      types(
        transition(
          tokenAccount({ delegate: OTHER, delegatedAmount: 100n }),
          tokenAccount({ delegate: null }),
        ),
      ),
    ).toEqual([]);
  });
});

describe("control transitions", () => {
  it("reports the token account owner being replaced", () => {
    const effects = transition(
      tokenAccount({ amount: 100n }),
      tokenAccount({ amount: 100n, owner: OTHER }),
    );
    expect(types(effects)).toEqual(["OWNER_CHANGE"]);
    expect(effects[0]?.owner).toBe(OWNER);
    expect(effects[0]?.counterparty).toBe(OTHER);
  });

  it("reports a close authority being set", () => {
    const effects = transition(
      tokenAccount({ amount: 100n }),
      tokenAccount({ amount: 100n, closeAuthority: OTHER }),
    );
    expect(types(effects)).toEqual(["AUTHORITY_CHANGE"]);
    expect(effects[0]?.authorityKind).toBe("close");
  });

  it("reports a mint authority being handed over", () => {
    const effects = transition(
      mintAccount(OWNER, null),
      mintAccount(OTHER, null),
    );
    expect(types(effects)).toEqual(["AUTHORITY_CHANGE"]);
    expect(effects[0]?.counterparty).toBe(OTHER);
  });

  it("reports a freeze authority appearing on a mint", () => {
    const effects = transition(
      mintAccount(OWNER, null),
      mintAccount(OWNER, OTHER),
    );
    expect(effects[0]?.authorityKind).toBe("freeze");
  });

  it("reports an authority being renounced", () => {
    // Set to none: irreversible, and a legitimate thing to do deliberately.
    const effects = transition(
      mintAccount(OWNER, null),
      mintAccount(null, null),
    );
    expect(types(effects)).toEqual(["AUTHORITY_CHANGE"]);
    expect(effects[0]?.counterparty).toBeUndefined();
  });

  it("reports the account's owning PROGRAM changing", () => {
    const effects = transition(
      systemAccount(1_000n),
      systemAccount(1_000n, TOKEN_PROGRAM_ID),
    );
    expect(types(effects)).toContain("OWNER_CHANGE");
  });
});

describe("existence transitions", () => {
  it("reports a created account and what it was funded with", () => {
    const effects = transition(null, systemAccount(890_880n));
    expect(types(effects)).toEqual(["ACCOUNT_CREATE", "BALANCE_INCREASE"]);
  });

  it("reports a created token account carrying a delegate already", () => {
    // There is no previous state to compare against, so the grant has to be
    // read out of the new account directly.
    const effects = transition(
      null,
      tokenAccount({ amount: 5n, delegate: OTHER, delegatedAmount: 5n }),
    );
    expect(types(effects)).toContain("DELEGATE_GRANT");
    expect(types(effects)).toContain("ACCOUNT_CREATE");
  });

  it("reports a closure from a zeroed post-state, not from a null", () => {
    // Verified on devnet: the runtime hands back a zeroed, System-owned
    // account rather than null. Testing for the null found nothing in 200
    // real transactions.
    const effects = transition(
      tokenAccount({ amount: 0n, lamports: 2_039_280n }),
      systemAccount(0n),
    );
    expect(types(effects)).toContain("ACCOUNT_CLOSE");
    expect(types(effects)).toContain("BALANCE_DECREASE");
  });

  it("reports both halves of a create-and-close in one transaction", () => {
    const effects = transition(null, systemAccount(0n));
    expect(types(effects)).toEqual(["ACCOUNT_CREATE", "ACCOUNT_CLOSE"]);
  });

  it("produces nothing for an account that was never observed", () => {
    const accounts: readonly ResolvedAccount[] = [
      {
        index: 0,
        address: ACCOUNT,
        signer: false,
        writable: true,
        source: "static",
        table: null,
      },
    ];
    // Absence of an effect is never evidence that nothing happened; coverage
    // is what reports this.
    expect(
      diffAccounts({
        accounts,
        before: new Map(),
        after: new Map(),
        feePayer: "",
        fee: null,
        invokedPrograms: [],
      }),
    ).toEqual([]);
  });
});

describe("the account state byte", () => {
  it("reports a token account being frozen", () => {
    // Freezing does not move a single token, so every amount comparison
    // passes. What it does is take away the owner's ability to move them --
    // a denial of the user's own assets, done by whoever holds the mint's
    // freeze authority.
    const effects = transition(
      tokenAccount({ amount: 1_000n }),
      tokenAccount({ amount: 1_000n, frozen: true }),
    );
    expect(types(effects)).toEqual(["ACCOUNT_FREEZE"]);
    expect(effects[0]?.owner).toBe(OWNER);
    expect(effects[0]?.mint).toBe(MINT);
  });

  it("says nothing when an account is thawed", () => {
    // Thawing hands control BACK. The vocabulary is about losing it -- the
    // same asymmetry that makes a delegate grant an effect and a revoke none.
    expect(
      types(
        transition(
          tokenAccount({ amount: 1_000n, frozen: true }),
          tokenAccount({ amount: 1_000n }),
        ),
      ),
    ).toEqual([]);
  });
});

describe("telling a Token-2022 mint from a token account", () => {
  /** A Token-2022 mint: base mint layout, padded, then the account-type byte. */
  function extendedMint(
    mintAuthority: string | null,
    extensionBytes = 24,
  ): AccountState {
    const base = mintAccount(mintAuthority, null);
    const data = Buffer.alloc(TOKEN_ACCOUNT_SIZE + 1 + extensionBytes);
    base.data.copy(data, 0);
    data.writeUInt8(2, TOKEN_ACCOUNT_SIZE); // account type: Mint
    return { ...base, owner: TOKEN_2022_PROGRAM_ID, data };
  }

  it("does not read a mint's bytes as a token account", () => {
    // A Token-2022 mint with extensions is padded to the size of an ACCOUNT
    // and then some, so a length test alone cannot tell them apart -- and
    // decoding a mint through the token layout reads its supply as an owner
    // and its authority bytes as a delegate. The byte at offset 165 is the
    // discriminator that exists precisely for this.
    const effects = transition(extendedMint(OWNER), extendedMint(OTHER));
    expect(types(effects)).toEqual(["AUTHORITY_CHANGE"]);
    expect(effects[0]?.authorityKind).toBe("mint");
    expect(effects[0]?.counterparty).toBe(OTHER);
  });

  it("does not invent a delegate or an owner change on a mint", () => {
    const effects = transition(extendedMint(OWNER), extendedMint(OWNER));
    expect(types(effects)).toEqual([]);
  });
});

describe("wrapped SOL and Token-2022", () => {
  it("counts a token account's value once, not twice", () => {
    // The lamport balance and the token amount on a wSOL account are the same
    // value seen twice. Emitting both would double what a manifest compares.
    const effects = transition(
      tokenAccount({ amount: 1_000n, lamports: 3_039_280n }),
      tokenAccount({ amount: 0n, lamports: 2_039_280n }),
    );
    expect(types(effects)).toEqual(["BALANCE_DECREASE"]);
    expect(effects[0]?.amount).toBe(1_000n);
  });

  it("decodes a Token-2022 account through the same offsets", () => {
    const effects = transition(
      tokenAccount({ amount: 10n, program: TOKEN_2022_PROGRAM_ID }),
      tokenAccount({ amount: 0n, program: TOKEN_2022_PROGRAM_ID }),
    );
    expect(types(effects)).toEqual(["BALANCE_DECREASE"]);
    expect(effects[0]?.amount).toBe(10n);
  });
});
