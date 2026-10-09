import { describe, expect, it } from "vitest";
import {
  MAX_TOLERANCE,
  isArgRef,
  toolManifestSchema,
  validateReferences,
  type ManifestProblem,
  type ToolManifest,
} from "../../src/types/manifest.js";

/** Transfer manifest, in the form given by aval-camada-avaliacao.md. */
const transfer: ToolManifest = {
  tool: "transfer",
  version: "1",
  args: { from: "address", to: "address", mint: "mint", amount: "amount" },
  must: [
    {
      type: "BALANCE_DECREASE",
      account: "arg:from",
      mint: "arg:mint",
      maxAmount: "arg:amount",
      unit: "decimal",
    },
    { type: "BALANCE_INCREASE", account: "arg:to", mint: "arg:mint" },
  ],
  may: [{ type: "ACCOUNT_CREATE" }, { type: "BALANCE_DECREASE", mint: "SOL" }],
  mustNot: [
    "DELEGATE_GRANT",
    "AUTHORITY_CHANGE",
    "OWNER_CHANGE",
    "ACCOUNT_CLOSE",
  ],
  accountScope: "args_plus_derived",
};

describe("ArgRef", () => {
  it("recognises a valid reference and refuses the rest", () => {
    expect(isArgRef("arg:from")).toBe(true);
    expect(isArgRef("arg:amountIn")).toBe(true);
    expect(isArgRef("from")).toBe(false);
    expect(isArgRef("arg:")).toBe(false);
    expect(isArgRef("arg:2x")).toBe(false);
    expect(isArgRef("ATokenAccXXXX")).toBe(false); // a literal address is not a ref
    expect(isArgRef(10)).toBe(false);
  });
});

describe("transfer manifest", () => {
  it("passes the schema and the reference validation", () => {
    expect(toolManifestSchema.safeParse(transfer).success).toBe(true);
    expect(validateReferences(transfer)).toEqual([]);
  });

  it("accepts a literal address next to a reference", () => {
    // `mint: "SOL"` in `may` is a literal; `mint: "arg:mint"` in `must` is a ref.
    expect(validateReferences(transfer)).toHaveLength(0);
  });
});

describe("validation catches the typo before the attack, not during", () => {
  it("reports a reference to an argument that does not exist", () => {
    const typo: ToolManifest = {
      ...transfer,
      must: [{ type: "BALANCE_DECREASE", account: "arg:form" }], // typo: form != from
    };
    const problems = validateReferences(typo);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.reason).toContain("not declared in args");
  });

  it("reports a reference with the wrong type", () => {
    const swapped: ToolManifest = {
      ...transfer,
      must: [{ type: "BALANCE_DECREASE", account: "arg:amount" }], // amount used as an account
    };
    const problems = validateReferences(swapped);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.reason).toContain("requires address");
  });

  it("reports an amount from a reference with no declared unit", () => {
    // Without a unit it would compare 10 (USDC) against 10000000n (raw).
    const noUnit: ToolManifest = {
      ...transfer,
      must: [
        {
          type: "BALANCE_DECREASE",
          account: "arg:from",
          maxAmount: "arg:amount",
        },
      ],
    };
    const problems = validateReferences(noUnit);
    expect(
      problems.some((p: ManifestProblem) =>
        p.reason.includes("no unit was declared"),
      ),
    ).toBe(true);
  });

  it("reports an effect that is mandatory and forbidden at once", () => {
    const contradictory: ToolManifest = {
      ...transfer,
      must: [{ type: "DELEGATE_GRANT", account: "arg:from" }],
    };
    const problems = validateReferences(contradictory);
    expect(
      problems.some((p: ManifestProblem) =>
        p.reason.includes("also in mustNot"),
      ),
    ).toBe(true);
  });

  it("treats a malformed ref as a literal, which is the documented contract", () => {
    const odd = {
      ...transfer,
      must: [{ type: "BALANCE_DECREASE", account: "arg:" }],
    };
    expect(toolManifestSchema.safeParse(odd).success).toBe(true);
    expect(validateReferences(toolManifestSchema.parse(odd))).toEqual([]);
  });
});

describe("tolerance cap", () => {
  it("accepts plausible slippage slack", () => {
    expect(
      toolManifestSchema.safeParse({
        ...transfer,
        may: [{ type: "BALANCE_DECREASE", tolerance: 0.03 }],
      }).success,
    ).toBe(true);
    expect(
      toolManifestSchema.safeParse({
        ...transfer,
        may: [{ type: "BALANCE_DECREASE", tolerance: MAX_TOLERANCE }],
      }).success,
    ).toBe(true);
  });

  it("refuses 0.3 typed in place of 0.03", () => {
    // 30% slack lets the skim fit inside the tolerance: the magnitude check
    // would never fire, and only the aggregate would see the sum.
    expect(
      toolManifestSchema.safeParse({
        ...transfer,
        may: [{ type: "BALANCE_DECREASE", tolerance: 0.3 }],
      }).success,
    ).toBe(false);
  });

  it("refuses negative tolerance", () => {
    expect(
      toolManifestSchema.safeParse({
        ...transfer,
        may: [{ type: "BALANCE_DECREASE", tolerance: -0.01 }],
      }).success,
    ).toBe(false);
  });
});

describe("the case no static policy can express", () => {
  it("DELEGATE_GRANT is forbidden in transfer and mandatory in approve", () => {
    const approve: ToolManifest = {
      tool: "approve",
      version: "1",
      args: { account: "address", delegate: "address", amount: "amount" },
      must: [
        {
          type: "DELEGATE_GRANT",
          account: "arg:account",
          counterparty: "arg:delegate",
          maxAmount: "arg:amount",
          unit: "decimal",
        },
      ],
      may: [],
      mustNot: ["BALANCE_DECREASE", "AUTHORITY_CHANGE"],
      accountScope: "args_only",
    };
    expect(validateReferences(approve)).toEqual([]);
    expect(transfer.mustNot).toContain("DELEGATE_GRANT");
    expect(approve.must[0]?.type).toBe("DELEGATE_GRANT");
  });
});
