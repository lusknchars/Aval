import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  SEVERITIES,
  checkKindSchema,
  compareSeverity,
  decisionSchema,
  highestSeverity,
  severitySchema,
  type Finding,
  type Verdict,
} from "../../src/types/verdict.js";

describe("severity", () => {
  it("has 4 levels, ordered from least to most severe", () => {
    expect(SEVERITIES).toEqual(["low", "medium", "high", "critical"]);
    expect(compareSeverity("critical", "high")).toBeGreaterThan(0);
    expect(compareSeverity("low", "medium")).toBeLessThan(0);
    expect(compareSeverity("high", "high")).toBe(0);
  });

  it("finds the highest severity in a list", () => {
    expect(highestSeverity(["low", "critical", "medium"])).toBe("critical");
    expect(highestSeverity(["low"])).toBe("low");
    expect(highestSeverity([])).toBeNull();
  });
});

describe("check and decision vocabularies", () => {
  it("covers the 5 checks plus scope, envelope and degradation", () => {
    expect(checkKindSchema.options).toEqual([
      "undeclared",
      "magnitude",
      "provenance",
      "scope",
      "aggregate",
      "content",
      "envelope",
      "coverage",
    ]);
  });

  it("has exactly three possible decisions", () => {
    expect(decisionSchema.options).toEqual(["allow", "flag", "deny"]);
    expect(decisionSchema.safeParse("block").success).toBe(false);
    expect(severitySchema.safeParse("fatal").success).toBe(false);
  });
});

describe("finding and verdict", () => {
  const finding: Finding = {
    check: "provenance",
    severity: "critical",
    rule: "provenance.retrieved_only",
    detail: {
      counterparty: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      foundIn: ["retrieved"],
      source: "https://blog.xyz/analysis",
      sourceTrust: "untrusted",
    },
  };

  it("stores structured detail, not free text", () => {
    expect(finding.detail["counterparty"]).toBe(
      "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    );
    expect(typeof finding.detail["foundIn"]).toBe("object");
    // explanation is optional and takes no part in the decision
    expect(finding.explanation).toBeUndefined();
  });

  it("traces every finding back to a named rule", () => {
    const verdict: Verdict = {
      actionId: "action-1",
      decision: "deny",
      findings: [
        finding,
        {
          check: "undeclared",
          severity: "critical",
          rule: "mustNot.DELEGATE_GRANT",
          detail: {},
        },
      ],
      evaluatedAt: 1_758_000_000_000,
      policyVersion: "manifests@1+thresholds@1",
    };
    expect(verdict.findings.map((f: Finding) => f.rule)).toEqual([
      "provenance.retrieved_only",
      "mustNot.DELEGATE_GRANT",
    ]);
    expect(
      highestSeverity(verdict.findings.map((f: Finding) => f.severity)),
    ).toBe("critical");
    expect(verdict.policyVersion).not.toBe("");
  });

  it("has defaults consistent with the ceiling rule", () => {
    expect(DEFAULT_THRESHOLDS.highsForDeny).toBe(2);
    expect(DEFAULT_THRESHOLDS.mediumsForFlag).toBe(1);
  });
});
