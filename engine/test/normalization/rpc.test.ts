import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  GENESIS_BY_NETWORK,
  normaliseInnerInstructions,
  onChainState,
  readRpcConfig,
  redact,
  simulatedState,
  toLamports,
} from "../../src/normalization/rpc.js";

const FAKE_URL =
  "https://devnet.helius-rpc.com/?api-key=00000000-1111-2222-3333-444444444444";

describe("config", () => {
  const base = {
    AVAL_RPC_COMMITMENT: "confirmed",
    AVAL_RPC_URL_DEVNET: FAKE_URL,
    AVAL_RPC_URL: FAKE_URL,
  };

  it("reads the right variable for each network", () => {
    const devnet = readRpcConfig(base, "devnet");
    expect(devnet.ok && devnet.value.network).toBe("devnet");
    const mainnet = readRpcConfig(base, "mainnet");
    expect(mainnet.ok && mainnet.value.commitment).toBe("confirmed");
  });

  it("fails without repeating the URL in the message", () => {
    const noUrl = readRpcConfig({ AVAL_RPC_COMMITMENT: "confirmed" }, "devnet");
    expect(noUrl.ok).toBe(false);
    if (!noUrl.ok) {
      expect(noUrl.failure.message).toContain("AVAL_RPC_URL_DEVNET");
      expect(noUrl.failure.message).not.toContain("api-key");
    }
  });

  it("refuses an invalid URL and a commitment outside the enum", () => {
    expect(
      readRpcConfig({ ...base, AVAL_RPC_URL_DEVNET: "not-a-url" }, "devnet").ok,
    ).toBe(false);
    expect(
      readRpcConfig({ ...base, AVAL_RPC_COMMITMENT: "recent" }, "devnet").ok,
    ).toBe(false);
  });

  it("knows the genesis hash of both networks", () => {
    expect(GENESIS_BY_NETWORK.devnet).toBe(
      "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    );
    expect(GENESIS_BY_NETWORK.mainnet).toBe(
      "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    );
  });
});

describe("redaction", () => {
  it("erases the whole URL and any api-key", () => {
    const raw = `failed to fetch ${FAKE_URL}: 401 Unauthorized`;
    const clean = redact(raw, FAKE_URL);
    expect(clean).not.toContain("helius-rpc");
    expect(clean).not.toContain("00000000-1111");
    expect(clean).toContain("401 Unauthorized");
  });

  it("erases an api-key even from a URL other than the configured one", () => {
    const other = redact(
      "error at https://other.xyz/?api-key=SECRET",
      FAKE_URL,
    );
    expect(other).toContain("api-key=***");
    expect(other).not.toContain("SECRET");
  });
});

describe("number -> bigint boundary", () => {
  it("converts a safe integer with no loss", () => {
    expect(toLamports(382313590904)).toEqual({
      lamports: 382313590904n,
      exact: true,
    });
    expect(toLamports(0)).toEqual({ lamports: 0n, exact: true });
  });

  it("marks as inexact what already arrived rounded", () => {
    // A rent-exempt account's rentEpoch arrives like this: u64::MAX already
    // rounded by JSON.parse.
    const roundedU64Max = 18446744073709552000;
    const converted = toLamports(roundedU64Max);
    expect(converted.exact).toBe(false);
    expect(converted.lamports).not.toBe(2n ** 64n - 1n);
  });
});

describe("state conversion", () => {
  const owner = PublicKey.default;

  it("converts an on-chain read and preserves the bytes", () => {
    const state = onChainState("Account1", {
      lamports: 650240,
      owner,
      executable: false,
      data: Buffer.from([1, 2, 3]),
    });
    expect(state?.lamports).toBe(650240n);
    expect(state?.owner).toBe(owner.toBase58());
    expect(state?.data).toEqual(Buffer.from([1, 2, 3]));
  });

  it("propagates a missing account as null, not as a zero balance", () => {
    expect(onChainState("Account1", null)).toBeNull();
  });

  it("decodes post-state in base64", () => {
    const r = simulatedState("Account1", {
      lamports: 1,
      owner: owner.toBase58(),
      executable: false,
      data: [Buffer.from([9, 9]).toString("base64"), "base64"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value?.data).toEqual(Buffer.from([9, 9]));
  });

  it("refuses an unexpected encoding instead of guessing", () => {
    const jsonParsed = simulatedState("Account1", {
      lamports: 1,
      owner: owner.toBase58(),
      executable: false,
      data: ["{}", "jsonParsed"],
    });
    expect(jsonParsed.ok).toBe(false);

    const notBase64 = simulatedState("Account1", {
      lamports: 1,
      owner: owner.toBase58(),
      executable: false,
      data: ["!!!not-base64!!!", "base64"],
    });
    expect(notBase64.ok).toBe(false);
  });
});

describe("inner instructions arrive in two different shapes", () => {
  it("reads the parsed shape, where the program id comes directly", () => {
    const refs = normaliseInnerInstructions([
      {
        index: 0,
        instructions: [
          {
            program: "spl-token",
            programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            parsed: {},
            stackHeight: 2,
          },
        ],
      },
    ]);
    expect(refs).toHaveLength(1);
    expect(refs?.[0]?.program).toBe(
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    );
    expect(refs?.[0]?.programIndex).toBeNull();
    expect(refs?.[0]?.stackHeight).toBe(2);
  });

  it("reads the compiled shape, where the program is an account index", () => {
    // The RPC emits this when it cannot parse the program -- which is exactly
    // the case for a program AVAL has never seen. The installed SDK rejects
    // this shape, which is why the response is parsed here instead.
    const refs = normaliseInnerInstructions([
      {
        index: 1,
        instructions: [{ programIdIndex: 7, accounts: [1, 2], data: "3Bxs4" }],
      },
    ]);
    expect(refs).toHaveLength(1);
    expect(refs?.[0]?.program).toBeNull();
    expect(refs?.[0]?.programIndex).toBe(7);
    expect(refs?.[0]?.outerIndex).toBe(1);
    expect(refs?.[0]?.stackHeight).toBeNull();
  });

  it("skips a shape it does not recognise instead of guessing", () => {
    const refs = normaliseInnerInstructions([
      { index: 0, instructions: [{ something: "else" }] },
    ]);
    expect(refs).toEqual([]);
  });

  it("tells not requested apart from none happened", () => {
    expect(normaliseInnerInstructions(null)).toBeNull();
    expect(normaliseInnerInstructions(undefined)).toBeNull();
    expect(normaliseInnerInstructions([])).toEqual([]);
  });
});
