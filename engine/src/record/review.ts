/**
 * The review queue: what repeated, and what a human could do about it.
 *
 * FLAG allows, so the queue is where a FLAG stops being a shrug. It groups the
 * record by SUBJECT -- an address, a tool, a program -- because that is the
 * grain a person can decide at. Nobody reviews forty verdicts about the same
 * address; they decide once about the address.
 *
 * NOTHING HERE DECIDES ANYTHING. Every item carries proposals, and a proposal
 * is a configuration diff waiting for a human. Repetition is the reason an
 * item is near the top of the list, never the reason it is applied:
 * frequency correlates with routine far more than with attack, and a counter
 * that promotes itself to a deny is a denial of service for anyone who can
 * make the counter go up.
 *
 * THE RETROSPECT IS THE POINT. A proposal is shown with the past verdicts it
 * would have changed, computed with `decide` -- the same combination function
 * that decides for real, not a description of it. An operator approves on what
 * would have been let through, not on whether the proposal reads reasonably.
 */
import { decide } from "../evaluation/verdict.js";
import { subjectKey } from "./subject.js";
import type { ActionRecord, RecordedFinding, Subject } from "../types/record.js";
import {
  compareSeverity,
  DEFAULT_THRESHOLDS,
  highestSeverity,
  type Decision,
  type Severity,
  type Thresholds,
} from "../types/verdict.js";

export type ProposalKind =
  | "trust_address"
  | "block_address"
  | "write_manifest"
  | "review_manifest"
  | "allow_program";

/** What approving would do to the findings that produced this item. */
export type ProposalEffect = "removes_findings" | "forces_deny";

export interface DecisionChange {
  readonly actionId: string;
  readonly at: number;
  readonly from: Decision;
  readonly to: Decision;
}

export interface Retrospect {
  /** Records in which this subject appears at all. */
  readonly considered: number;
  readonly changed: readonly DecisionChange[];
  /**
   * True when approving could also ADD findings that nobody can compute yet.
   *
   * Writing a manifest for a tool removes `coverage.no_manifest` and then
   * starts checking things that were never checked, so the retrospect is a
   * floor rather than a prediction. Saying so is the difference between a
   * measurement and a sales pitch.
   */
  readonly speculative: boolean;
}

export interface Proposal {
  readonly kind: ProposalKind;
  readonly effect: ProposalEffect;
  /** Rule prefixes this proposal would silence. Empty for a deny proposal. */
  readonly silences: readonly string[];
  readonly retrospect: Retrospect;
}

export interface RuleCount {
  readonly rule: string;
  readonly severity: Severity;
  readonly count: number;
}

export interface ReviewItem {
  readonly subject: Subject;
  /** Records where this subject was part of a finding and nothing was allowed. */
  readonly occurrences: number;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly highestSeverity: Severity;
  readonly rules: readonly RuleCount[];
  /** Most recent first, capped: a reviewer needs examples, not the archive. */
  readonly recentActions: readonly string[];
  readonly proposals: readonly Proposal[];
}

/**
 * Findings with no subject at all, counted by rule.
 *
 * `coverage.token_extensions` carries a count of accounts and no address, so
 * it can never be a button. It still has to be visible, because "this rule
 * fired on four hundred transactions" is the strongest signal there is that
 * the rule, and not the traffic, is what needs work.
 */
export interface UnattributableRule {
  readonly rule: string;
  readonly severity: Severity;
  readonly count: number;
}

export interface ReviewQueue {
  readonly items: readonly ReviewItem[];
  readonly unattributable: readonly UnattributableRule[];
  readonly records: number;
  readonly minOccurrences: number;
}

export interface ReviewOptions {
  /** How many appearances before a subject is worth a person's attention. */
  readonly minOccurrences?: number;
  /**
   * Thresholds used for the replay.
   *
   * The record stores a `policyVersion`, not the thresholds themselves, so a
   * replay is against the policy in force NOW. That is the right question --
   * "what would approving this do going forward" -- and it is worth being
   * explicit that it is not "what would it have done under the old policy".
   */
  readonly thresholds?: Thresholds;
  readonly maxExamples?: number;
}

const PROVENANCE_AND_SCOPE: readonly string[] = ["provenance.", "scope."];

function silenced(
  findings: readonly RecordedFinding[],
  subject: Subject,
  prefixes: readonly string[],
): readonly RecordedFinding[] {
  if (prefixes.length === 0) return findings;
  return findings.filter((finding) => {
    const aboutSubject = finding.subjects.some(
      (s) => s.kind === subject.kind && s.value === subject.value,
    );
    if (!aboutSubject) return true;
    return !prefixes.some((prefix) => finding.rule.startsWith(prefix));
  });
}

function retrospectOf(
  records: readonly ActionRecord[],
  subject: Subject,
  effect: ProposalEffect,
  silences: readonly string[],
  thresholds: Thresholds,
  speculative: boolean,
): Retrospect {
  const changed: DecisionChange[] = [];
  let considered = 0;

  for (const record of records) {
    const appears = record.findings.some((finding) =>
      finding.subjects.some(
        (s) => s.kind === subject.kind && s.value === subject.value,
      ),
    );
    if (!appears) continue;
    considered++;

    if (effect === "forces_deny") {
      if (record.decision !== "deny")
        changed.push({
          actionId: record.actionId,
          at: record.at,
          from: record.decision,
          to: "deny",
        });
      continue;
    }

    const after = decide(silenced(record.findings, subject, silences), thresholds);
    if (after !== record.decision)
      changed.push({
        actionId: record.actionId,
        at: record.at,
        from: record.decision,
        to: after,
      });
  }

  return { considered, changed, speculative };
}

/**
 * Which proposals a subject admits, given the rules that actually fired.
 *
 * A subject only ever gets a proposal that has an outcome. An address that
 * shows up purely through a coverage gap gets nothing to approve, because
 * allowlisting it would not have changed the gap.
 */
function proposalKinds(
  subject: Subject,
  rules: readonly string[],
): readonly { readonly kind: ProposalKind; readonly effect: ProposalEffect; readonly silences: readonly string[]; readonly speculative: boolean }[] {
  if (subject.kind === "address") {
    const trustable = rules.some((rule) =>
      PROVENANCE_AND_SCOPE.some((prefix) => rule.startsWith(prefix)),
    );
    if (!trustable) return [];
    return [
      {
        kind: "trust_address",
        effect: "removes_findings",
        silences: PROVENANCE_AND_SCOPE,
        speculative: false,
      },
      {
        kind: "block_address",
        effect: "forces_deny",
        silences: [],
        speculative: false,
      },
    ];
  }

  if (subject.kind === "program") {
    return [
      {
        kind: "allow_program",
        effect: "removes_findings",
        silences: ["undeclared.program_not_allowed"],
        speculative: false,
      },
    ];
  }

  // A tool. Either no manifest exists, or one exists and keeps firing.
  if (rules.includes("coverage.no_manifest"))
    return [
      {
        kind: "write_manifest",
        effect: "removes_findings",
        silences: ["coverage.no_manifest"],
        // A new manifest starts checking what was never checked.
        speculative: true,
      },
    ];
  return [
    {
      kind: "review_manifest",
      effect: "removes_findings",
      silences: [],
      speculative: true,
    },
  ];
}

export function reviewQueue(
  records: readonly ActionRecord[],
  options: ReviewOptions = {},
): ReviewQueue {
  const minOccurrences = options.minOccurrences ?? 2;
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const maxExamples = options.maxExamples ?? 5;

  interface Bucket {
    readonly subject: Subject;
    readonly actions: Set<string>;
    readonly recent: { actionId: string; at: number }[];
    readonly rules: Map<string, RuleCount>;
    firstSeen: number;
    lastSeen: number;
  }
  const buckets = new Map<string, Bucket>();
  const unattributable = new Map<string, UnattributableRule>();

  for (const record of records) {
    // An allowed action is not something to review. It still counts in the
    // retrospect below, because approving must be judged against everything
    // the subject ever touched.
    for (const finding of record.findings) {
      if (finding.subjects.length === 0) {
        const seen = unattributable.get(finding.rule);
        unattributable.set(finding.rule, {
          rule: finding.rule,
          severity: finding.severity,
          count: (seen?.count ?? 0) + 1,
        });
        continue;
      }
      if (record.decision === "allow") continue;

      for (const subject of finding.subjects) {
        const key = subjectKey(subject);
        const bucket = buckets.get(key) ?? {
          subject,
          actions: new Set<string>(),
          recent: [],
          rules: new Map<string, RuleCount>(),
          firstSeen: record.at,
          lastSeen: record.at,
        };
        bucket.actions.add(record.actionId);
        bucket.recent.push({ actionId: record.actionId, at: record.at });
        const rule = bucket.rules.get(finding.rule);
        bucket.rules.set(finding.rule, {
          rule: finding.rule,
          // The worst severity this rule reached for this subject.
          severity:
            rule === undefined ||
            compareSeverity(finding.severity, rule.severity) > 0
              ? finding.severity
              : rule.severity,
          count: (rule?.count ?? 0) + 1,
        });
        bucket.firstSeen = Math.min(bucket.firstSeen, record.at);
        bucket.lastSeen = Math.max(bucket.lastSeen, record.at);
        buckets.set(key, bucket);
      }
    }
  }

  const items: ReviewItem[] = [];
  for (const bucket of buckets.values()) {
    const occurrences = bucket.actions.size;
    if (occurrences < minOccurrences) continue;

    const rules = [...bucket.rules.values()].sort(
      (a, b) => compareSeverity(b.severity, a.severity) || b.count - a.count,
    );
    const worst = highestSeverity(rules.map((rule) => rule.severity));
    if (worst === null) continue;

    const recentActions = [
      ...new Set(
        [...bucket.recent]
          .sort((a, b) => b.at - a.at)
          .map((entry) => entry.actionId),
      ),
    ].slice(0, maxExamples);

    items.push({
      subject: bucket.subject,
      occurrences,
      firstSeen: bucket.firstSeen,
      lastSeen: bucket.lastSeen,
      highestSeverity: worst,
      rules,
      recentActions,
      proposals: proposalKinds(
        bucket.subject,
        rules.map((rule) => rule.rule),
      ).map((proposal) => ({
        kind: proposal.kind,
        effect: proposal.effect,
        silences: proposal.silences,
        retrospect: retrospectOf(
          records,
          bucket.subject,
          proposal.effect,
          proposal.silences,
          thresholds,
          proposal.speculative,
        ),
      })),
    });
  }

  items.sort(
    (a, b) =>
      b.occurrences - a.occurrences ||
      compareSeverity(b.highestSeverity, a.highestSeverity) ||
      subjectKey(a.subject).localeCompare(subjectKey(b.subject)),
  );

  return {
    items,
    unattributable: [...unattributable.values()].sort(
      (a, b) => b.count - a.count,
    ),
    records: records.length,
    minOccurrences,
  };
}
