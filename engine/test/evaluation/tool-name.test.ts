/**
 * The identifier layer, tested against the two ways it can fail.
 *
 * It can fail by NOT matching -- and then a real integration degrades every
 * call to no_manifest and the checks never run. It can fail by matching the
 * WRONG manifest -- and then a token transfer is judged against the SOL
 * ceiling, which is worse, because a wrong manifest can produce an ALLOW.
 * The second kind gets more tests than the first.
 */
import { describe, expect, it } from "vitest";
import {
  MANIFEST_TOOLS,
  lookupManifest,
  manifestFor,
} from "../../src/evaluation/manifests/index.js";
import {
  aliasKeys,
  aliasTargets,
  canonicalToolName,
  resolveToolName,
} from "../../src/evaluation/manifests/tool-name.js";

describe("canonicalisation only touches spelling", () => {
  it("collapses the four spellings a single framework ships", () => {
    for (const spelling of [
      "transfer",
      "TRANSFER",
      "TRANSFER_ACTION",
      "SolanaTransferTool",
      "solana-transfer-tool",
      "transfer.action",
    ]) {
      expect(canonicalToolName(spelling)).toBe("transfer");
    }
  });

  it("handles consecutive capitals", () => {
    expect(canonicalToolName("SolanaSPLTransferTool")).toBe("spl_transfer");
  });

  it("keeps `spl`, because it is what says the asset is a token", () => {
    expect(canonicalToolName("SPL_TRANSFER")).toBe("spl_transfer");
    expect(canonicalToolName("spl_transfer")).not.toBe("transfer");
  });

  it("never strips a name down to nothing", () => {
    expect(canonicalToolName("tool")).toBe("tool");
    expect(canonicalToolName("solana")).toBe("solana");
    expect(canonicalToolName("")).toBe("");
  });
});

describe("the alias table is internally sound", () => {
  it("points every alias at a manifest that exists", () => {
    for (const target of aliasTargets()) {
      expect(MANIFEST_TOOLS.has(target), `dangling alias target: ${target}`).toBe(
        true,
      );
    }
  });

  it("keeps every key in canonical form, or it can never be reached", () => {
    for (const key of aliasKeys()) {
      expect(canonicalToolName(key), `unreachable alias key: ${key}`).toBe(key);
    }
  });
});

describe("names frameworks actually use resolve to the right primitive", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["TRANSFER_SOL", "transfer_sol"],
    ["SolanaTransferSolTool", "transfer_sol"],
    ["send_sol", "transfer_sol"],
    ["SPL_TRANSFER", "transfer_token"],
    ["transferSplToken", "transfer_token"],
    ["SolanaTokenTransferTool", "transfer_token"],
    ["TRADE_ACTION", "swap"],
    ["jupiterSwap", "swap"],
    ["approveDelegate", "approve"],
    ["REVOKE_TOKEN", "revoke"],
    ["closeTokenAccount", "close_account"],
    ["BURN", "burn_tokens"],
    ["setMintAuthority", "set_authority"],
    ["freezeTokenAccount", "freeze_account"],
  ];
  for (const [spelling, tool] of cases) {
    it(`${spelling} -> ${tool}`, () => {
      expect(manifestFor(spelling)?.tool).toBe(tool);
    });
  }
});

describe("a name that means two primitives is decided by the call, not by us", () => {
  it("reads `transfer` with a mint as a token transfer", () => {
    const found = lookupManifest("TRANSFER", {
      to: "recipient",
      amount: "1.5",
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    });
    expect(found?.manifest.tool).toBe("transfer_token");
    expect(found?.via).toBe("by_argument");
  });

  it("reads `transfer` without a mint as SOL", () => {
    expect(
      lookupManifest("SolanaTransferTool", { to: "recipient", amount: 1000 })
        ?.manifest.tool,
    ).toBe("transfer_sol");
  });

  it("treats an empty mint as absent rather than as a token", () => {
    expect(
      lookupManifest("transfer", { to: "recipient", amount: 1, mint: "  " })
        ?.manifest.tool,
    ).toBe("transfer_sol");
  });

  it("refuses to guess when no arguments are available", () => {
    // Degrade, never open: this becomes coverage.no_manifest, not the wrong
    // ceiling on the wrong asset.
    expect(manifestFor("transfer")).toBeNull();
    expect(manifestFor("SolanaTransferTool")).toBeNull();
  });
});

describe("unknown stays unknown", () => {
  it("does not invent a manifest for a tool nobody wrote one for", () => {
    for (const unknown of [
      "brand_new_tool",
      "stake",
      "SolanaLendTool",
      "openPerpTradeLong",
      "",
      "tool",
    ]) {
      expect(manifestFor(unknown), unknown).toBeNull();
    }
  });

  it("does not map a lending or staking verb onto a transfer", () => {
    expect(manifestFor("deposit", { amount: 1 })).toBeNull();
    expect(manifestFor("withdraw", { amount: 1 })).toBeNull();
    expect(manifestFor("stake", { amount: 1 })).toBeNull();
  });

  it("reports an exact name as exact, so the audit trail is honest", () => {
    expect(resolveToolName("swap", MANIFEST_TOOLS)).toEqual({
      tool: "swap",
      via: "exact",
    });
  });
});
