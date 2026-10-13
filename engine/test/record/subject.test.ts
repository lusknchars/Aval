import { describe, expect, it } from "vitest";
import { subjectKey, subjectsOf } from "../../src/record/subject.js";
import type { Finding } from "../../src/types/verdict.js";

describe("a finding reduces to what a human can decide about", () => {
  it("takes the counterparty from a provenance finding", () => {
    const finding: Finding = {
      check: "provenance",
      severity: "high",
      rule: "provenance.unexplained",
      detail: { counterparty: "9xQeWv", origin: "unexplained" },
    };
    expect(subjectsOf(finding)).toEqual([{ kind: "address", value: "9xQeWv" }]);
  });

  it("takes the tool from a missing manifest", () => {
    expect(
      subjectsOf({
        check: "coverage",
        severity: "medium",
        rule: "coverage.no_manifest",
        detail: { tool: "SolanaLendTool", note: "..." },
      }),
    ).toEqual([{ kind: "tool", value: "SolanaLendTool" }]);
  });

  it("takes both the program and the tool from a program that is not allowed", () => {
    expect(
      subjectsOf({
        check: "undeclared",
        severity: "medium",
        rule: "undeclared.program_not_allowed",
        detail: { tool: "transfer_token", program: "JUP6Lk" },
      }),
    ).toEqual([
      { kind: "program", value: "JUP6Lk" },
      { kind: "tool", value: "transfer_token" },
    ]);
  });

  it("uses the account itself for a scope finding", () => {
    expect(
      subjectsOf({
        check: "scope",
        severity: "high",
        rule: "scope.outside_args_only",
        detail: { tool: "approve", account: "Acc1", owner: null },
      }),
    ).toEqual([
      { kind: "address", value: "Acc1" },
      { kind: "tool", value: "approve" },
    ]);
  });

  it("gives no subject to a coverage finding that carries only a count", () => {
    // Recorded and counted by rule, never a button. An approve control over
    // something the reviewer cannot see is worse than no control.
    expect(
      subjectsOf({
        check: "coverage",
        severity: "medium",
        rule: "coverage.accounts_unobserved",
        detail: { accounts: 3, note: "..." },
      }),
    ).toEqual([]);
  });

  it("ignores a field that is present but empty", () => {
    expect(
      subjectsOf({
        check: "provenance",
        severity: "high",
        rule: "provenance.untrusted_source",
        detail: { counterparty: "   " },
      }),
    ).toEqual([]);
  });

  it("never reads a non-string, so a malformed detail cannot forge a subject", () => {
    expect(
      subjectsOf({
        check: "provenance",
        severity: "high",
        rule: "provenance.unexplained",
        detail: { counterparty: { toString: () => "evil" } },
      }),
    ).toEqual([]);
  });

  it("keys a subject by kind and value together", () => {
    // A tool and an address that happen to share a name are two subjects.
    expect(subjectKey({ kind: "tool", value: "x" })).not.toBe(
      subjectKey({ kind: "address", value: "x" }),
    );
  });
});
