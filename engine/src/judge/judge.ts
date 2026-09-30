/**
 * Applying a judge's opinion to a verdict: the one-way rule, in code.
 *
 * The type already cannot express "allow". This file is the second half:
 * whatever the judge says, the decision that comes out is never LESS severe
 * than the one that went in, and every change is a named finding so the
 * record can say "the judge did this, for this reason, under this model".
 *
 * A judge that is unavailable is a result, not an exception. The verdict
 * stands, and a low-severity coverage finding says the layer was skipped.
 * Silently omitting a layer the operator believes is in place is the failure
 * this guards against; it costs nothing on the decision and everything on
 * the record.
 */
import type { Judge, JudgeInput, JudgeResult } from "../types/judge.js";
import {
  compareSeverity,
  SEVERITIES,
  type Decision,
  type Finding,
  type Verdict,
} from "../types/verdict.js";

/** Decisions from least to most severe, for "never less than". */
const ORDER: readonly Decision[] = ["allow", "flag", "deny"];

function tighter(a: Decision, b: Decision): Decision {
  return ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a;
}

/**
 * The verdict with the opinion applied.
 *
 * Pure, and the only place a judge touches a decision. `decide` is not re-run:
 * the judge's finding carries the severity that WOULD produce its decision
 * under default thresholds, and the decision is set to the tighter of the two
 * explicitly, so a customer with unusual thresholds still gets exactly what
 * the judge asked for and never less.
 */
export function applyOpinion(
  verdict: Verdict,
  result: JudgeResult,
  judgeName: string,
): Verdict {
  if (!result.ok) {
    const finding: Finding = {
      check: "coverage",
      severity: "low",
      rule: "coverage.judge_unavailable",
      detail: {
        judge: judgeName,
        reason: result.reason,
        latencyMs: result.latencyMs,
        note: "the deterministic verdict stands; the judge could only have tightened it",
      },
    };
    return { ...verdict, findings: [...verdict.findings, finding] };
  }

  const { opinion } = result;
  if (opinion.tighten === null) return verdict;

  const to = opinion.tighten.to;
  const decision = tighter(verdict.decision, to);
  const finding: Finding = {
    check: "content",
    severity: to === "deny" ? "critical" : "medium",
    rule: `judge.${to}`,
    detail: {
      judge: judgeName,
      model: opinion.model,
      reason: opinion.tighten.reason,
      before: verdict.decision,
      after: decision,
      latencyMs: result.latencyMs,
    },
  };
  return { ...verdict, decision, findings: [...verdict.findings, finding] };
}

/** True when there is nothing left for a judge to tighten. */
export function alreadyTightest(verdict: Verdict): boolean {
  return verdict.decision === "deny";
}

/** The most severe finding present, for callers that display it. */
export function worstSeverity(verdict: Verdict): string | null {
  let worst: (typeof SEVERITIES)[number] | null = null;
  for (const finding of verdict.findings) {
    if (worst === null || compareSeverity(finding.severity, worst) > 0)
      worst = finding.severity;
  }
  return worst;
}

/**
 * A judge that has nothing to say. For wiring, for tests, and for a
 * deployment that has not plugged one in yet: the pipeline runs whole, and
 * the record shows the judge was consulted and agreed.
 */
export class NoJudge implements Judge {
  readonly name = "none";

  async judge(_input: JudgeInput): Promise<JudgeResult> {
    return {
      ok: true,
      opinion: { tighten: null, model: "none" },
      latencyMs: 0,
    };
  }
}
