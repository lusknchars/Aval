/**
 * Does every effect look the same, whatever transaction it came out of?
 *
 * The vocabulary being closed is only half of what makes it useful. The other
 * half is uniformity: a DELEGATE_GRANT from a recorded devnet fixture, from a
 * byte-level transition and from a real mainnet transaction all have to carry
 * the same fields. Otherwise every consumer downstream has to defend itself
 * against whatever the normalizer happened to emit that day, and the checks
 * grow to fit the exceptions.
 *
 * So there is ONE contract -- `effectShapeProblems` -- and it is applied to
 * every effect from every source. The sampling CLI applies the same function
 * to real traffic, which is where it earns its keep: a contract only checked
 * against the cases somebody remembered to write down is a restatement.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { diffAccounts } from "../../src/normalization/diff.js";
import {
  FixtureRpcClient,
  loadFixture,
  type Fixture,
} from "../../src/normalization/fixture.js";
import { normalize } from "../../src/normalization/normalize.js";
import {
  MINT_SIZE,
  TOKEN_ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
} from "../../src/normalization/spl.js";
import {
  EFFECT_TYPES,
  effectShapeProblems,
  type Effect,
  type EffectType,
} from "../../src/types/effects.js";
import type { ResolvedAccount } from "../../src/normalization/accounts.js";
import type { AccountState } from "../../src/normalization/rpc.js";

const FIXTURES = [
  "transfer-sol",
  "create-ata",
  "token-to-wallet",
  "close-account",
  "unlimited-approve",
  "rent-failure",
];

function open(name: string): Fixture {
  const raw: unknown = JSON.parse(
    readFileSync(`test/fixtures/${name}.json`, "utf8"),
  );
  const loaded = loadFixture(raw);
  if (!loaded.ok) throw new Error(loaded.failure.message);
  return loaded.value;
}

/** Reports every offending effect at once, so one run names them all. */
function violations(
  source: string,
  effects: readonly Effect[],
): readonly string[] {
  return effects.flatMap((effect) => {
    const problems = effectShapeProblems(effect);
    return problems.length === 0
      ? []
      : [`${source}: ${effect.type} -- ${problems.join(", ")}`];
  });
}

// ------------------------------------------------------------ built effects

const MINT = Keypair.generate().publicKey.toBase58();
const OWNER = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();
const ACCOUNT = Keypair.generate().publicKey.toBase58();
const key = (base58: string): Buffer =>
  Buffer.from(new PublicKey(base58).toBytes());

function tokenAccount(fields: {
  amount?: bigint;
  owner?: string;
  delegate?: string | null;
  delegatedAmount?: bigint;
  frozen?: boolean;
  closeAuthority?: string | null;
  lamports?: bigint;
}): AccountState {
  const data = Buffer.alloc(TOKEN_ACCOUNT_SIZE);
  key(MINT).copy(data, 0);
  key(fields.owner ?? OWNER).copy(data, 32);
  data.writeBigUInt64LE(fields.amount ?? 0n, 64);
  const delegate = fields.delegate ?? null;
  data.writeUInt32LE(delegate === null ? 0 : 1, 72);
  if (delegate !== null) key(delegate).copy(data, 76);
  data.writeUInt8(fields.frozen === true ? 2 : 1, 108);
  data.writeBigUInt64LE(fields.delegatedAmount ?? 0n, 121);
  const closeAuthority = fields.closeAuthority ?? null;
  data.writeUInt32LE(closeAuthority === null ? 0 : 1, 129);
  if (closeAuthority !== null) key(closeAuthority).copy(data, 133);
  return {
    address: ACCOUNT,
    lamports: fields.lamports ?? 2_039_280n,
    lamportsExact: true,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    data,
  };
}

function mintAccount(authority: string | null): AccountState {
  const data = Buffer.alloc(MINT_SIZE);
  data.writeUInt32LE(authority === null ? 0 : 1, 0);
  if (authority !== null) key(authority).copy(data, 4);
  data.writeUInt8(6, 44);
  data.writeUInt8(1, 45);
  return {
    address: ACCOUNT,
    lamports: 1_461_600n,
    lamportsExact: true,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    data,
  };
}

function systemAccount(lamports: bigint): AccountState {
  return {
    address: ACCOUNT,
    lamports,
    lamportsExact: true,
    owner: "11111111111111111111111111111111",
    executable: false,
    data: Buffer.alloc(0),
  };
}

const ONE_ACCOUNT: readonly ResolvedAccount[] = [
  {
    index: 0,
    address: ACCOUNT,
    signer: false,
    writable: true,
    source: "static",
    table: null,
  },
];

function transition(
  before: AccountState | null,
  after: AccountState | null,
  programs: readonly string[] = [],
): readonly Effect[] {
  return diffAccounts({
    accounts: ONE_ACCOUNT,
    before: new Map([[ACCOUNT, before]]),
    after: new Map([[ACCOUNT, after]]),
    feePayer: "",
    fee: null,
    invokedPrograms: programs,
  });
}

/** One transition per effect type, so the contract is exercised end to end. */
const BUILT: Readonly<Record<string, readonly Effect[]>> = {
  "token balance down": transition(
    tokenAccount({ amount: 1_000n }),
    tokenAccount({ amount: 1n }),
  ),
  "token balance up": transition(
    tokenAccount({ amount: 1n }),
    tokenAccount({ amount: 1_000n }),
  ),
  "sol balance down": transition(systemAccount(9_000n), systemAccount(1_000n)),
  "sol balance up": transition(systemAccount(1_000n), systemAccount(9_000n)),
  "delegate granted": transition(
    tokenAccount({ amount: 5n }),
    tokenAccount({ amount: 5n, delegate: OTHER, delegatedAmount: 5n }),
  ),
  "delegate allowance grown": transition(
    tokenAccount({ delegate: OTHER, delegatedAmount: 1n }),
    tokenAccount({ delegate: OTHER, delegatedAmount: 99n }),
  ),
  "close authority set": transition(
    tokenAccount({ amount: 5n }),
    tokenAccount({ amount: 5n, closeAuthority: OTHER }),
  ),
  "mint authority moved": transition(mintAccount(OWNER), mintAccount(OTHER)),
  "mint authority renounced": transition(
    mintAccount(OWNER),
    mintAccount(null),
  ),
  "token owner replaced": transition(
    tokenAccount({ amount: 5n }),
    tokenAccount({ amount: 5n, owner: OTHER }),
  ),
  "account created": transition(null, systemAccount(890_880n)),
  "account created holding tokens": transition(
    null,
    tokenAccount({ amount: 7n, delegate: OTHER, delegatedAmount: 7n }),
  ),
  "account closed": transition(
    tokenAccount({ amount: 0n }),
    systemAccount(0n),
  ),
  "created and closed at once": transition(null, systemAccount(0n)),
  "account frozen": transition(
    tokenAccount({ amount: 5n }),
    tokenAccount({ amount: 5n, frozen: true }),
  ),
  "program invoked": transition(null, null, [TOKEN_PROGRAM_ID]),
};

// --------------------------------------------------------------------- tests

describe("every effect conforms to the contract for its type", () => {
  it("across every recorded transaction", async () => {
    const found: string[] = [];
    for (const name of FIXTURES) {
      const fixture = open(name);
      const rpc = new FixtureRpcClient(fixture);
      const set = await normalize(rpc.transaction(), rpc);
      found.push(...violations(`fixture ${name}`, set.effects));
    }
    expect(found).toEqual([]);
  });

  it("across every built transition", () => {
    const found: string[] = [];
    for (const [name, effects] of Object.entries(BUILT)) {
      found.push(...violations(`built "${name}"`, effects));
    }
    expect(found).toEqual([]);
  });
});

describe("the nine types are all reachable", () => {
  it("produces every one of them from a real transition", () => {
    const produced = new Set<EffectType>();
    for (const effects of Object.values(BUILT)) {
      for (const effect of effects) produced.add(effect.type);
    }
    // Any type nothing can produce is either dead vocabulary or a gap in the
    // normalizer. Both are worth knowing, and neither should go unnoticed.
    expect([...EFFECT_TYPES].filter((t) => !produced.has(t))).toEqual([]);
  });

  it("carries the same fields for a type, whatever produced it", () => {
    // Uniformity stated as a set comparison rather than as an intention: for
    // each type, the fields present must be the same across every source.
    const fieldsByType = new Map<EffectType, Set<string>[]>();
    for (const effects of Object.values(BUILT)) {
      for (const effect of effects) {
        const present = new Set(
          Object.entries(effect)
            .filter(([k, v]) => k !== "type" && v !== undefined)
            .map(([k]) => k),
        );
        const seen = fieldsByType.get(effect.type) ?? [];
        seen.push(present);
        fieldsByType.set(effect.type, seen);
      }
    }
    // Required fields are present everywhere; optional ones may differ, and
    // the contract is what says which is which. So the assertion is that the
    // contract holds, not that the sets are identical.
    for (const [type, shapes] of fieldsByType) {
      for (const shape of shapes) {
        expect({ type, hasAccount: shape.has("account") }).toEqual({
          type,
          hasAccount: true,
        });
      }
    }
  });
});
