/**
 * The judge, tested on the one property that lets an LLM sit before the
 * wallet at all: it can only tighten.
 */
import { describe, expect, it } from "vitest";
import { applyOpinion, alreadyTightest, NoJudge } from "../../src/judge/judge.js";
import { judgeOpinionSchema, type JudgeResult } from "../../src/types/judge.js";
import type { Verdict } from "../../src/types/verdict.js";
import { readFileSync } from "node:fs";
import { FixtureRpcClient, loadFixture } from "../../src/normalization/fixture.js";
import { normalize } from "../../src/normalization/normalize.js";
import type { EffectSet } from "../../src/types/effects.js";

/** A real EffectSet from a recorded transaction, no network. */
async function recordedEffects(): Promise<EffectSet> {
  const raw: unknown = JSON.parse(readFileSync("test/fixtures/transfer-sol.json", "utf8"));
  const loaded = loadFixture(raw);
  if (!loaded.ok) throw new Error(loaded.failure.message);
  const rpc = new FixtureRpcClient(loaded.value);
  return normalize(rpc.transaction(), rpc);
}


function verdict(decision: Verdict["decision"]): Verdict {
  return {
    actionId: "a",
    messageDigest: "d",
    decision,
    findings: [],
    evaluatedAt: 1,
    policyVersion: "p",
  };
}

const says = (to: "flag" | "deny", reason = "looks like a drain"): JudgeResult => ({
  ok: true,
  opinion: { tighten: { to, reason }, model: "gemma-3-12b" },
  latencyMs: 40,
});

describe("the judge can only tighten", () => {
  it("cannot express allow at all", () => {
    // There is no shape in the contract that means "open the door".
    expect(judgeOpinionSchema.safeParse({ tighten: { to: "allow", reason: "fine" }, model: "m" }).success).toBe(false);
    expect(judgeOpinionSchema.safeParse({ tighten: null, model: "m" }).success).toBe(true);
  });

  it("turns an allow into a flag, and says who did it and why", () => {
    const after = applyOpinion(verdict("allow"), says("flag"), "gemma");
    expect(after.decision).toBe("flag");
    const finding = after.findings.find((f) => f.rule === "judge.flag");
    expect(finding?.detail).toMatchObject({
      judge: "gemma",
      model: "gemma-3-12b",
      reason: "looks like a drain",
      before: "allow",
      after: "flag",
    });
  });

  it("turns a flag into a deny", () => {
    expect(applyOpinion(verdict("flag"), says("deny"), "gemma").decision).toBe("deny");
  });

  it("never makes a decision less severe", () => {
    // A judge asking for FLAG on a DENY changes nothing about the decision.
    const after = applyOpinion(verdict("deny"), says("flag"), "gemma");
    expect(after.decision).toBe("deny");
  });

  it("is skipped when there is nothing left to tighten", () => {
    expect(alreadyTightest(verdict("deny"))).toBe(true);
    expect(alreadyTightest(verdict("flag"))).toBe(false);
  });

  it("leaves the verdict untouched when the judge has nothing to add", () => {
    const before = verdict("allow");
    const after = applyOpinion(
      before,
      { ok: true, opinion: { tighten: null, model: "gemma-3-12b" }, latencyMs: 12 },
      "gemma",
    );
    expect(after).toEqual(before);
  });
});

describe("an unavailable judge is a result, not an exception", () => {
  it("keeps the deterministic verdict and says the layer was skipped", () => {
    const after = applyOpinion(
      verdict("allow"),
      { ok: false, reason: "timed out", latencyMs: 5000 },
      "gemma",
    );
    expect(after.decision).toBe("allow");
    const finding = after.findings.find((f) => f.rule === "coverage.judge_unavailable");
    expect(finding?.severity).toBe("low");
    expect(finding?.detail["reason"]).toBe("timed out");
  });
});

describe("the stub", () => {
  it("agrees with everything, so the pipeline runs whole before a judge exists", async () => {
    const result = await new NoJudge().judge({
      record: {
        actionId: "a", agentId: "x", at: 1, decision: "allow", signed: false,
        tool: "t", manifestTool: null, manifestVia: null, messageDigest: null,
        policyVersion: "p", feePayer: null, findings: [],
      },
      effects: await recordedEffects(),
      userGoal: "",
      toolCall: { name: "t", args: {} },
      chunks: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.opinion.tighten).toBeNull();
  });
});
