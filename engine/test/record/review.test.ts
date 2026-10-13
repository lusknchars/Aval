/**
 * The queue, tested on the thing that makes it safe: the retrospect.
 *
 * A proposal that says "this would have changed nothing" when it would have
 * opened the door is worse than no queue, because it buys an approval with a
 * false number.
 */
import { describe, expect, it } from "vitest";
import { reviewQueue } from "../../src/record/review.js";
import type { ActionRecord, RecordedFinding } from "../../src/types/record.js";

let clock = 1_700_000_000_000;

function provenance(address: string): RecordedFinding {
  return {
    check: "provenance",
    severity: "high",
    rule: "provenance.unexplained",
    subjects: [{ kind: "address", value: address }],
    detail: { counterparty: address },
  };
}

function noManifest(tool: string): RecordedFinding {
  return {
    check: "coverage",
    severity: "medium",
    rule: "coverage.no_manifest",
    subjects: [{ kind: "tool", value: tool }],
    detail: { tool },
  };
}

function record(
  findings: readonly RecordedFinding[],
  decision: ActionRecord["decision"],
  actionId = `a${clock++}`,
): ActionRecord {
  return {
    actionId,
    agentId: "agent",
    at: clock,
    decision,
    signed: decision !== "deny",
    tool: "transfer_token",
    manifestTool: "transfer_token",
    manifestVia: "exact",
    messageDigest: null,
    policyVersion: "p1",
    feePayer: "Payer",
    findings,
  };
}

describe("grouping is by subject, because that is what a person decides about", () => {
  it("collapses many verdicts about one address into one item", () => {
    const records = [
      record([provenance("Drain")], "flag"),
      record([provenance("Drain")], "flag"),
      record([provenance("Drain")], "flag"),
    ];
    const queue = reviewQueue(records);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]?.subject).toEqual({ kind: "address", value: "Drain" });
    expect(queue.items[0]?.occurrences).toBe(3);
  });

  it("hides a subject seen once, and shows it once it repeats", () => {
    expect(reviewQueue([record([provenance("Once")], "flag")]).items).toEqual([]);
    expect(
      reviewQueue([
        record([provenance("Twice")], "flag"),
        record([provenance("Twice")], "flag"),
      ]).items,
    ).toHaveLength(1);
  });

  it("does not put an allowed action in the queue", () => {
    expect(
      reviewQueue([
        record([provenance("Fine")], "allow"),
        record([provenance("Fine")], "allow"),
      ]).items,
    ).toEqual([]);
  });

  it("counts a finding with no subject by rule, with no button", () => {
    const orphan: RecordedFinding = {
      check: "coverage",
      severity: "medium",
      rule: "coverage.accounts_unobserved",
      subjects: [],
      detail: { accounts: 4 },
    };
    const queue = reviewQueue([
      record([orphan], "flag"),
      record([orphan], "flag"),
    ]);
    expect(queue.items).toEqual([]);
    expect(queue.unattributable).toEqual([
      { rule: "coverage.accounts_unobserved", severity: "medium", count: 2 },
    ]);
  });
});

describe("the retrospect is computed with the real combination rule", () => {
  it("says exactly which past verdicts trusting an address would have flipped", () => {
    const records = [
      record([provenance("Maybe")], "flag", "one"),
      record([provenance("Maybe")], "flag", "two"),
    ];
    const trust = reviewQueue(records).items[0]?.proposals.find(
      (p) => p.kind === "trust_address",
    );
    expect(trust?.retrospect.considered).toBe(2);
    expect(trust?.retrospect.changed.map((c) => [c.actionId, c.from, c.to])).toEqual([
      ["one", "flag", "allow"],
      ["two", "flag", "allow"],
    ]);
    expect(trust?.retrospect.speculative).toBe(false);
  });

  it("does not claim a flip when another finding would have held the verdict", () => {
    // Trusting the address silences provenance; the undeclared OWNER_CHANGE is
    // still there, and it is critical. A queue that reported ALLOW here would
    // be selling an approval that does nothing.
    const alsoCritical: RecordedFinding = {
      check: "undeclared",
      severity: "critical",
      rule: "undeclared.OWNER_CHANGE",
      subjects: [{ kind: "tool", value: "transfer_token" }],
      detail: { tool: "transfer_token", account: "Acc" },
    };
    const records = [
      record([provenance("Maybe"), alsoCritical], "deny", "one"),
      record([provenance("Maybe"), alsoCritical], "deny", "two"),
    ];
    const trust = reviewQueue(records).items.find(
      (item) => item.subject.value === "Maybe",
    )?.proposals.find((p) => p.kind === "trust_address");
    expect(trust?.retrospect.changed).toEqual([]);
  });

  it("counts an allowed record in the retrospect even though it is not in the queue", () => {
    // Approving has to be judged against everything the subject touched, or
    // the operator is shown a filtered history.
    const records = [
      record([provenance("Mixed")], "flag", "one"),
      record([provenance("Mixed")], "flag", "two"),
      record([provenance("Mixed")], "allow", "three"),
    ];
    const item = reviewQueue(records).items[0];
    expect(item?.occurrences).toBe(2);
    expect(
      item?.proposals.find((p) => p.kind === "trust_address")?.retrospect
        .considered,
    ).toBe(3);
  });

  it("shows blocking as what it is: these would have been denied", () => {
    const records = [
      record([provenance("Bad")], "flag", "one"),
      record([provenance("Bad")], "deny", "two"),
      record([provenance("Bad")], "allow", "three"),
    ];
    const block = reviewQueue(records).items[0]?.proposals.find(
      (p) => p.kind === "block_address",
    );
    expect(block?.effect).toBe("forces_deny");
    // The one already denied is not a change; the allowed one is.
    expect(block?.retrospect.changed.map((c) => c.actionId).sort()).toEqual([
      "one",
      "three",
    ]);
  });
});

describe("a proposal only exists when it has an outcome", () => {
  it("proposes writing a manifest, and admits the number is a floor", () => {
    const queue = reviewQueue([
      record([noManifest("SolanaLendTool")], "flag"),
      record([noManifest("SolanaLendTool")], "flag"),
    ]);
    const proposal = queue.items[0]?.proposals[0];
    expect(proposal?.kind).toBe("write_manifest");
    // A new manifest starts checking what nothing checked before, so the
    // retrospect cannot be a prediction.
    expect(proposal?.retrospect.speculative).toBe(true);
  });

  it("offers nothing to approve on an address that only appeared in a coverage gap", () => {
    const coverageOnly: RecordedFinding = {
      check: "coverage",
      severity: "medium",
      rule: "coverage.inexact_lamports",
      subjects: [{ kind: "address", value: "Acc" }],
      detail: { counterparty: "Acc" },
    };
    const item = reviewQueue([
      record([coverageOnly], "flag"),
      record([coverageOnly], "flag"),
    ]).items.find((i) => i.subject.value === "Acc");
    // Allowlisting it would not have removed the gap, so there is no button.
    expect(item?.proposals).toEqual([]);
  });

  it("puts the noisiest subject first", () => {
    const queue = reviewQueue([
      record([provenance("Loud")], "flag"),
      record([provenance("Loud")], "flag"),
      record([provenance("Loud")], "flag"),
      record([provenance("Quiet")], "flag"),
      record([provenance("Quiet")], "flag"),
    ]);
    expect(queue.items.map((i) => i.subject.value)).toEqual(["Loud", "Quiet"]);
  });
});
