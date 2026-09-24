import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { manifestFindings } from "../../src/evaluation/manifest.js";
import {
  FixtureRpcClient,
  loadFixture,
} from "../../src/normalization/fixture.js";
import { normalize } from "../../src/normalization/normalize.js";
import type { EffectSet } from "../../src/types/effects.js";
import type { ToolManifest } from "../../src/types/manifest.js";

async function effectSetOf(name: string): Promise<EffectSet> {
  const raw: unknown = JSON.parse(
    readFileSync(`test/fixtures/${name}.json`, "utf8"),
  );
  const loaded = loadFixture(raw);
  if (!loaded.ok) throw new Error(loaded.failure.message);
  const rpc = new FixtureRpcClient(loaded.value);
  return normalize(rpc.transaction(), rpc);
}

function addressesOf(name: string): readonly string[] {
  const raw: unknown = JSON.parse(
    readFileSync(`test/fixtures/${name}.json`, "utf8"),
  );
  const loaded = loadFixture(raw);
  if (!loaded.ok) throw new Error(loaded.failure.message);
  return loaded.value.before.addresses;
}

const SWAP: ToolManifest = {
  tool: "swap",
  version: "1",
  args: { from: "address", to: "address", amountIn: "amount" },
  must: [{ type: "BALANCE_DECREASE", account: "arg:from" }],
  may: [
    { type: "PROGRAM_INVOKE" },
    { type: "ACCOUNT_CREATE" },
    { type: "BALANCE_INCREASE" },
  ],
  mustNot: ["DELEGATE_GRANT", "AUTHORITY_CHANGE", "OWNER_CHANGE"],
  accountScope: "args_plus_derived",
};

const CLOSE_FORBIDDEN: ToolManifest = {
  tool: "transfer",
  version: "1",
  args: { from: "address", to: "address" },
  must: [],
  may: [
    { type: "PROGRAM_INVOKE" },
    { type: "ACCOUNT_CREATE" },
    { type: "BALANCE_DECREASE" },
  ],
  mustNot: ["ACCOUNT_CLOSE", "DELEGATE_GRANT"],
  accountScope: "args_plus_derived",
};

describe("the case no static policy can express", () => {
  it("makes the delegate critical inside a swap", async () => {
    const effects = await effectSetOf("unlimited-approve");
    const [from = ""] = addressesOf("unlimited-approve");
    const findings = manifestFindings({
      effects,
      manifest: SWAP,
      toolCall: { name: "swap", args: { from, to: "SolAcc", amountIn: 400 } },
    });
    const forbidden = findings.find((f) => f.rule === "mustNot.DELEGATE_GRANT");
    expect(forbidden?.severity).toBe("critical");
  });

  it("says nothing about the same delegate when the manifest expects it", async () => {
    const effects = await effectSetOf("unlimited-approve");
    const [account = "", , delegate = ""] = addressesOf("unlimited-approve");
    const approve: ToolManifest = {
      tool: "approve",
      version: "1",
      args: { account: "address", delegate: "address" },
      must: [{ type: "DELEGATE_GRANT", counterparty: "arg:delegate" }],
      may: [
        { type: "PROGRAM_INVOKE" },
        { type: "ACCOUNT_CREATE" },
        { type: "BALANCE_DECREASE" },
      ],
      mustNot: ["AUTHORITY_CHANGE", "OWNER_CHANGE"],
      accountScope: "args_only",
    };
    const findings = manifestFindings({
      effects,
      manifest: approve,
      toolCall: { name: "approve", args: { account, delegate } },
    });
    // Same transaction, same effect. The manifest is the only thing that
    // changed, and it is what tells the two apart.
    expect(findings.filter((f) => f.check === "undeclared")).toEqual([]);
  });
});

describe("the gap that used to pass", () => {
  it("catches a closed account the manifest forbids", async () => {
    // With no manifest, closing an account went through unnoticed. The
    // safety net does not cover it on purpose -- this is the check that does.
    const effects = await effectSetOf("close-account");
    const [from = "", to = ""] = addressesOf("close-account");
    const findings = manifestFindings({
      effects,
      manifest: CLOSE_FORBIDDEN,
      toolCall: { name: "transfer", args: { from, to } },
    });
    const closed = findings.find((f) => f.rule === "mustNot.ACCOUNT_CLOSE");
    expect(closed?.severity).toBe("high");
  });
});

describe("magnitude", () => {
  const set: EffectSet = {
    effects: [
      { type: "BALANCE_DECREASE", account: "Acc", mint: "SOL", amount: 500n },
    ],
    slot: 1,
    baselineSlot: 1,
    fee: null,
    simulation: { status: "executed", unitsConsumed: 1 },
    coverage: { referenced: [], observed: [], unobserved: [], blindSpots: [] },
  };
  const manifest: ToolManifest = {
    tool: "transfer",
    version: "1",
    args: { from: "address", amount: "amount" },
    must: [
      {
        type: "BALANCE_DECREASE",
        account: "arg:from",
        maxAmount: "arg:amount",
        unit: "raw",
      },
    ],
    may: [],
    mustNot: [],
    accountScope: "args_only",
  };

  it("fires when the transaction moves more than the tool call declared", () => {
    const findings = manifestFindings({
      effects: set,
      manifest,
      toolCall: { name: "transfer", args: { from: "Acc", amount: 100 } },
    });
    const magnitude = findings.find(
      (f) => f.rule === "magnitude.above_declared",
    );
    expect(magnitude?.severity).toBe("high");
    expect(magnitude?.detail["observed"]).toBe("500");
    expect(magnitude?.detail["ceiling"]).toBe("100");
  });

  it("stays silent within the declared amount", () => {
    const findings = manifestFindings({
      effects: set,
      manifest,
      toolCall: { name: "transfer", args: { from: "Acc", amount: 500 } },
    });
    expect(findings.filter((f) => f.check === "magnitude")).toEqual([]);
  });

  it("allows slack for slippage, computed without floats", () => {
    const withTolerance: ToolManifest = {
      ...manifest,
      must: [
        {
          type: "BALANCE_DECREASE",
          account: "arg:from",
          maxAmount: "arg:amount",
          unit: "raw",
          tolerance: 0.03,
        },
      ],
    };
    // 490 plus 3% is 504.7, so 500 fits.
    const inside = manifestFindings({
      effects: set,
      manifest: withTolerance,
      toolCall: { name: "transfer", args: { from: "Acc", amount: 490 } },
    });
    expect(inside.filter((f) => f.check === "magnitude")).toEqual([]);

    // 400 plus 3% is 412, so 500 does not.
    const outside = manifestFindings({
      effects: set,
      manifest: withTolerance,
      toolCall: { name: "transfer", args: { from: "Acc", amount: 400 } },
    });
    expect(outside.some((f) => f.check === "magnitude")).toBe(true);
  });

  it("converts decimal amounts using the mint's decimals", () => {
    const decimalManifest: ToolManifest = {
      ...manifest,
      must: [
        {
          type: "BALANCE_DECREASE",
          account: "arg:from",
          maxAmount: "arg:amount",
          unit: "decimal",
        },
      ],
    };
    const usdc: EffectSet = {
      ...set,
      effects: [
        {
          type: "BALANCE_DECREASE",
          account: "Acc",
          mint: "USDC",
          amount: 400_000_000n,
        },
      ],
    };
    // The tool call says 400 USDC; the effect says 400000000 raw. Without the
    // conversion this is the most obvious false positive in the system.
    const findings = manifestFindings({
      effects: usdc,
      manifest: decimalManifest,
      toolCall: { name: "transfer", args: { from: "Acc", amount: 400 } },
      decimals: new Map([["USDC", 6]]),
    });
    expect(findings.filter((f) => f.check === "magnitude")).toEqual([]);
  });

  it("degrades instead of guessing when the decimals are unknown", () => {
    const decimalManifest: ToolManifest = {
      ...manifest,
      must: [
        {
          type: "BALANCE_DECREASE",
          account: "arg:from",
          maxAmount: "arg:amount",
          unit: "decimal",
        },
      ],
    };
    const findings = manifestFindings({
      effects: set,
      manifest: decimalManifest,
      toolCall: { name: "transfer", args: { from: "Acc", amount: 400 } },
    });
    expect(
      findings.some((f) => f.rule === "coverage.unresolved_reference"),
    ).toBe(true);
  });
});

describe("the seam between a manifest and the real tool", () => {
  it("reports a reference the tool call never provided", async () => {
    const effects = await effectSetOf("transfer-sol");
    // The manifest says arg:from; the agent's tool takes `source`. Nobody
    // typed anything wrong, and the check still cannot run.
    const findings = manifestFindings({
      effects,
      manifest: SWAP,
      toolCall: { name: "swap", args: { source: "Acc", dest: "Other" } },
    });
    const unresolved = findings.find(
      (f) => f.rule === "coverage.unresolved_reference",
    );
    expect(unresolved?.severity).toBe("medium");
    expect(unresolved?.detail["reference"]).toBe("arg:from");
  });

  it("reports a tool with no manifest instead of passing it", async () => {
    const effects = await effectSetOf("transfer-sol");
    const findings = manifestFindings({
      effects,
      manifest: null,
      toolCall: { name: "brand_new_tool", args: {} },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("coverage.no_manifest");
  });

  it("reports an effect the manifest neither expects nor forbids", async () => {
    const effects = await effectSetOf("create-ata");
    const narrow: ToolManifest = {
      tool: "noop",
      version: "1",
      args: {},
      must: [],
      may: [],
      mustNot: [],
      accountScope: "open",
    };
    const findings = manifestFindings({
      effects,
      manifest: narrow,
      toolCall: { name: "noop", args: {} },
    });
    expect(findings.some((f) => f.rule.startsWith("undeclared."))).toBe(true);
  });
});
