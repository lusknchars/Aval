import { describe, expect, it } from "vitest";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";

/**
 * Environment smoke test. It tests nothing about VETO -- it proves the
 * foundation stands. No network calls anywhere.
 */
describe("environment", () => {
  it("compares bigint correctly in expect", () => {
    // Every token amount in VETO is a bigint. If the runner did not compare
    // bigint properly, every balance test would be a silent false positive.
    const u64Max = 18_446_744_073_709_551_615n;
    expect(u64Max).toEqual(2n ** 64n - 1n);
    expect({ delta: -10n }).toEqual({ delta: -10n });
    expect(10n).not.toEqual(10);
  });

  it("decodes an SPL token account straight from the bytes", () => {
    // The project's central scope cut: fixed layout, no IDL.
    expect(ACCOUNT_SIZE).toBe(165);

    const key = PublicKey.default;
    const bytes = Buffer.alloc(ACCOUNT_SIZE);
    AccountLayout.encode(
      {
        mint: key,
        owner: key,
        amount: 500n,
        delegateOption: 0,
        delegate: key,
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: key,
      },
      bytes,
    );

    const decoded = AccountLayout.decode(bytes);
    expect(decoded.amount).toBe(500n);
    expect(typeof decoded.amount).toBe("bigint");
  });

  it("round-trips an address through base58", () => {
    // The provenance check searches for the base58 string in context chunks.
    const key = new PublicKey(TOKEN_PROGRAM_ID);
    const text = key.toBase58();
    expect(bs58.decode(text)).toHaveLength(32);
    expect(new PublicKey(bs58.decode(text)).toBase58()).toBe(text);
  });

  it("validates boundary input with zod", () => {
    // ActionContext, ToolManifest and TaskEnvelope all come in this way.
    const provenance = z.enum([
      "user",
      "system",
      "retrieved",
      "memory",
      "tool_output",
    ]);
    expect(provenance.parse("retrieved")).toBe("retrieved");
    expect(() => provenance.parse("invented")).toThrow();
  });
});
