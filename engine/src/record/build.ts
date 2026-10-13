/**
 * A verdict, turned into the row that outlives it.
 *
 * Shared by the gate and by anything that evaluates without signing, so the
 * review queue reads one shape whatever produced it. A second builder would
 * eventually group differently from the first, and then the queue would be
 * about which code path ran rather than about what happened.
 */
import { subjectsOf } from "./subject.js";
import type { ActionContext } from "../types/context.js";
import type { ToolMatch } from "../types/manifest.js";
import type { ActionRecord } from "../types/record.js";
import type { Verdict } from "../types/verdict.js";

export interface RecordInput {
  readonly verdict: Verdict;
  readonly context: ActionContext;
  /** The manifest the call resolved to, and how. null when none matched. */
  readonly manifestTool: string | null;
  readonly manifestVia: ToolMatch | null;
  readonly feePayer: string | null;
  /** Whether a signature actually happened, which is not the same as allowed. */
  readonly signed: boolean;
}

export function buildActionRecord(input: RecordInput): ActionRecord {
  const { verdict, context } = input;
  return {
    actionId: verdict.actionId,
    agentId: context.agentId,
    at: verdict.evaluatedAt,
    decision: verdict.decision,
    signed: input.signed,
    // As the AGENT spelled it. The normalised name is the other field, and
    // keeping both is what makes "no manifest matched this name" answerable.
    tool: context.toolCall.name,
    manifestTool: input.manifestTool,
    manifestVia: input.manifestVia,
    messageDigest: verdict.messageDigest,
    policyVersion: verdict.policyVersion,
    feePayer: input.feePayer,
    // Subjects are resolved once, at write time, so the queue groups the way
    // the rules grouped when they fired -- not the way today's extractor does.
    findings: verdict.findings.map((finding) => ({
      check: finding.check,
      severity: finding.severity,
      rule: finding.rule,
      subjects: subjectsOf(finding),
      detail: finding.detail,
    })),
  };
}
