import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FixtureRpcClient,
  loadFixture,
  type Fixture,
} from "../../src/normalization/fixture.js";
import {
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  UNLIMITED_ALLOWANCE,
  decodeMint,
  decodeTokenAccount,
  formatRawAmount,
  isTokenProgram,
  isUnlimitedAllowance,
  parseDecimalAmount,
} from "../../src/normalization/spl.js";
import type { AccountState } from "../../src/normalization/rpc.js";

function open(name: string): Fixture {
  const raw: unknown = JSON.parse(
    readFileSync(`test/fixtures/${name}.json`, "utf8"),
  );
  const loaded = loadFixture(raw);
  if (!loaded.ok) throw new Error(loaded.failure.message);
  return loaded.value;
}

/** Post-simulation state of one account, straight from a recorded fixture. */
async function postState(
  fixtureName: string,
  index: number,
): Promise<AccountState> {
  const fixture = open(fixtureName);
  const rpc = new FixtureRpcClient(fixture);
  const sim = await rpc.simulate(rpc.transaction(), {
    accounts: fixture.simulation.requestedAccounts,
  });
  if (!sim.ok) throw new Error(sim.failure.message);
  const account = sim.value.accounts[index];
  if (account === null || account === undefined)
    throw new Error(`account ${index} is null in ${fixtureName}`);
  return account;
}

describe("token account decoding, against recorded bytes", () => {
  it("reads a freshly created ATA", async () => {
    const ata = await postState("create-ata", 1);
    expect(ata.data).toHaveLength(TOKEN_ACCOUNT_SIZE);

    const decoded = decodeTokenAccount(ata.data, ata.owner);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    expect(decoded.value.mint).toBe(
      "So11111111111111111111111111111111111111112",
    );
    expect(decoded.value.amount).toBe(0n);
    expect(decoded.value.state).toBe("initialized");
    expect(decoded.value.program).toBe("token");
    expect(decoded.value.hasExtensions).toBe(false);
    // No delegate was granted: it must be null, never 32 zero bytes read as
    // an address, and the delegated amount must not be trusted.
    expect(decoded.value.delegate).toBeNull();
    expect(decoded.value.delegatedAmount).toBe(0n);
  });

  it("reads the unlimited delegate -- the flagship signal", async () => {
    const ata = await postState("unlimited-approve", 1);
    const decoded = decodeTokenAccount(ata.data, ata.owner);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    expect(decoded.value.delegate).not.toBeNull();
    expect(decoded.value.delegatedAmount).toBe(UNLIMITED_ALLOWANCE);
    expect(decoded.value.delegatedAmount).toBe(18_446_744_073_709_551_615n);
    expect(isUnlimitedAllowance(decoded.value.delegatedAmount)).toBe(true);
  });

  it("tells the token controller apart from the owning program", async () => {
    const fixture = open("unlimited-approve");
    const ata = await postState("unlimited-approve", 1);
    const decoded = decodeTokenAccount(ata.data, ata.owner);
    if (!decoded.ok) return;

    // The account's owner program is the Token Program...
    expect(ata.owner).toBe(TOKEN_PROGRAM_ID);
    // ...while the owner INSIDE the data is who controls the tokens, and it is
    // neither the program nor the fee payer.
    expect(decoded.value.owner).not.toBe(TOKEN_PROGRAM_ID);
    expect(decoded.value.owner).not.toBe(fixture.before.addresses[0]);
  });

  it("refuses an account that is not owned by a token program", async () => {
    const feePayer = await postState("transfer-sol", 0);
    const decoded = decodeTokenAccount(feePayer.data, feePayer.owner);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok)
      expect(decoded.reason).toContain("not owned by a token program");
  });

  it("refuses a buffer that is too short instead of reading past the end", () => {
    const short = Buffer.alloc(100);
    const decoded = decodeTokenAccount(short, TOKEN_PROGRAM_ID);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toContain("165 bytes, got 100");
  });

  it("refuses a buffer whose type byte says it is a mint", () => {
    // A mint with extensions is padded to the size of an account, so the base
    // offsets would "decode" it into a plausible token account -- reading its
    // supply as an owner.
    const mintShaped = Buffer.alloc(TOKEN_ACCOUNT_SIZE + 40);
    mintShaped.writeUInt8(2, TOKEN_ACCOUNT_SIZE); // account type = Mint
    const decoded = decodeTokenAccount(mintShaped, TOKEN_2022_PROGRAM_ID);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toContain("mint");
  });

  it("flags Token-2022 extensions as present rather than decoding them", () => {
    // Base layout plus an extension area: the base fields stay valid, the
    // extensions do not get decoded, and the caller has to say so.
    const withExtensions = Buffer.alloc(TOKEN_ACCOUNT_SIZE + 40);
    withExtensions.writeUInt8(1, 108); // state = initialized
    withExtensions.writeUInt8(1, TOKEN_ACCOUNT_SIZE); // account type = Account
    const decoded = decodeTokenAccount(withExtensions, TOKEN_2022_PROGRAM_ID);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.program).toBe("token-2022");
    expect(decoded.value.hasExtensions).toBe(true);
  });
});

describe("mint decoding, against recorded bytes", () => {
  it("reads wrapped SOL's mint", async () => {
    const fixture = open("create-ata");
    const rpc = new FixtureRpcClient(fixture);
    const read = await rpc.readAccounts(fixture.before.addresses);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const mintAccount = read.value.accounts[2];
    expect(mintAccount).not.toBeNull();
    if (mintAccount === null || mintAccount === undefined) return;

    expect(mintAccount.data).toHaveLength(MINT_SIZE);
    const decoded = decodeMint(mintAccount.data, mintAccount.owner);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    // Wrapped SOL has 9 decimals, like lamports, and no mint authority.
    expect(decoded.value.decimals).toBe(9);
    expect(decoded.value.isInitialized).toBe(true);
    expect(decoded.value.mintAuthority).toBeNull();
    expect(decoded.value.freezeAuthority).toBeNull();
  });
});

describe("token program identification", () => {
  it("knows both token programs and nothing else", () => {
    expect(isTokenProgram(TOKEN_PROGRAM_ID)).toBe(true);
    expect(isTokenProgram(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(isTokenProgram("11111111111111111111111111111111")).toBe(false);
  });
});

describe("amounts never pass through a float", () => {
  it("formats a raw amount exactly", () => {
    expect(formatRawAmount(400_000_000n, 6)).toBe("400");
    expect(formatRawAmount(1_940_000_000n, 9)).toBe("1.94");
    expect(formatRawAmount(1n, 9)).toBe("0.000000001");
    expect(formatRawAmount(0n, 6)).toBe("0");
    // 18 significant digits: a float would have rounded this.
    expect(formatRawAmount(UNLIMITED_ALLOWANCE, 6)).toBe(
      "18446744073709.551615",
    );
  });

  it("parses a decimal amount back to raw", () => {
    const parsed = parseDecimalAmount("400", 6);
    expect(parsed.ok && parsed.value).toBe(400_000_000n);
    const fractional = parseDecimalAmount("1.94", 9);
    expect(fractional.ok && fractional.value).toBe(1_940_000_000n);
  });

  it("round-trips without loss", () => {
    for (const raw of [0n, 1n, 89_102_774n, UNLIMITED_ALLOWANCE]) {
      const text = formatRawAmount(raw, 6);
      const back = parseDecimalAmount(text, 6);
      expect(back.ok && back.value).toBe(raw);
    }
  });

  it("refuses more precision than the mint has", () => {
    // 0.0000001 USDC does not exist: USDC has 6 decimals.
    const tooPrecise = parseDecimalAmount("0.0000001", 6);
    expect(tooPrecise.ok).toBe(false);
    if (!tooPrecise.ok) expect(tooPrecise.reason).toContain("more precision");
    expect(parseDecimalAmount("-5", 6).ok).toBe(false);
    expect(parseDecimalAmount("1e3", 6).ok).toBe(false);
  });
});
