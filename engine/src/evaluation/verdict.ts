/**
 * Turning findings into a decision.
 *
 * No weighted score, on purpose. A number is impossible to explain to an
 * auditor and impossible to calibrate with confidence: nobody can say why 0.73
 * blocks and 0.71 does not. The rule here is a severity ceiling, so every
 * decision traces back to a named finding and a specific rule.
 *
 * The policy version is a hash of everything that was in force, so it changes
 * on its own when any part changes. Nobody has to remember to bump a number,
 * which is exactly where manual versioning breaks.
 */
import { createHash } from "node:crypto";
import { alwaysCriticalFindings, coverageFindings } from "./critical.js";
import {
  provenanceFindings,
  EMPTY_PROVENANCE_CONFIG,
  type ProvenanceConfig,
} from "./provenance.js";
import type { EffectSet } from "../types/effects.js";
import type { ActionContext } from "../types/context.js";
import {
  DEFAULT_THRESHOLDS,
  type Decision,
  type Finding,
  type Severity,
  type Thresholds,
  type Verdict,
} from "../types/verdict.js";

function countBySeverity(
  findings: readonly Finding[],
): Readonly<Record<Severity, number>> {
  const counts = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return counts;
}

/**
 * The ceiling rule, in the order the specification states it.
 *
 * Reading it top to bottom is the whole explanation of any decision this
 * system makes.
 */
export function decide(
  findings: readonly Finding[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Decision {
  const counts = countBySeverity(findings);

  if (counts.critical > 0) return "deny";
  if (counts.high >= thresholds.highsForDeny) return "deny";
  if (counts.high > 0) return "flag";
  if (counts.medium >= thresholds.mediumsForFlag) return "flag";
  return "allow";
}

/** Everything that was in force when a decision was made. */
export interface PolicyIdentity {
  /** Tool manifests and their versions. */
  readonly manifests: readonly {
    readonly tool: string;
    readonly version: string;
  }[];
  readonly thresholds: Thresholds;
  /** Source patterns the customer configured, without their trust levels. */
  readonly sourcePatterns: readonly string[];
  readonly allowlist: readonly string[];
}

export const EMPTY_POLICY: PolicyIdentity = {
  manifests: [],
  thresholds: DEFAULT_THRESHOLDS,
  sourcePatterns: [],
  allowlist: [],
};

/**
 * A short, stable identifier for the policy that produced a verdict.
 *
 * Derived rather than declared: change a manifest, a threshold or one line of
 * customer configuration and the version changes with it. Sorted before
 * hashing so the same policy always produces the same string.
 */
export function policyVersion(policy: PolicyIdentity): string {
  const canonical = JSON.stringify({
    manifests: [...policy.manifests]
      .map((m) => `${m.tool}@${m.version}`)
      .sort((a, b) => a.localeCompare(b)),
    thresholds: policy.thresholds,
    sourcePatterns: [...policy.sourcePatterns].sort((a, b) =>
      a.localeCompare(b),
    ),
    allowlist: [...policy.allowlist].sort((a, b) => a.localeCompare(b)),
  });
  return `p1-${createHash("sha256").update(canonical).digest("hex").slice(0, 6)}`;
}

export interface EvaluationInput {
  readonly effects: EffectSet;
  readonly context: ActionContext;
  readonly provenance?: ProvenanceConfig;
  readonly thresholds?: Thresholds;
  readonly policy?: PolicyIdentity;
}

/**
 * Runs every check that works today and combines them.
 *
 * Deliberately missing, and each for its own reason: the manifest checks need
 * manifests written per tool, the aggregate needs persisted history, and the
 * task envelope needs a model call once per task. Until they exist, the safety
 * net and provenance carry the decision -- which is the point of both being
 * designed to work alone.
 */
export function evaluate(input: EvaluationInput): Verdict {
  const provenanceConfig = input.provenance ?? EMPTY_PROVENANCE_CONFIG;
  const findings: Finding[] = [
    ...alwaysCriticalFindings(input.effects),
    ...coverageFindings(input.effects),
    ...provenanceFindings(input.effects, input.context, provenanceConfig),
  ];

  return {
    actionId: input.context.actionId,
    decision: decide(findings, input.thresholds ?? DEFAULT_THRESHOLDS),
    findings,
    evaluatedAt: Date.now(),
    policyVersion: policyVersion(input.policy ?? EMPTY_POLICY),
  };
}

/** One line per finding, in the order they fired. For logs and for the CLI. */
export function explainVerdict(verdict: Verdict): readonly string[] {
  return verdict.findings.map(
    (finding) => `${finding.severity.padEnd(8)} ${finding.rule}`,
  );
}
