/**
 * What a human would actually decide about.
 *
 * A reviewer never decides about a verdict -- forty verdicts on the same
 * address are one decision, not forty. So every finding is reduced to the
 * SUBJECTS it is about, and the review queue groups by subject.
 *
 * A finding with no extractable subject is still recorded and still counted by
 * rule -- it simply never becomes a proposal. `coverage.token_extensions`
 * carries a COUNT of accounts and no address, and an approve control over
 * something the reviewer cannot see is worse than no control at all.
 *
 * Nothing here reads free text. Every field it looks at is a structured field
 * the checks already write.
 */
import type { Subject, SubjectKind } from "../types/record.js";
import type { Finding } from "../types/verdict.js";

export type { Subject, SubjectKind } from "../types/record.js";

/** Stable grouping key. */
export function subjectKey(subject: Subject): string {
  return `${subject.kind}:${subject.value}`;
}

function text(
  detail: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = detail[field];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Checks whose finding a manifest could have expressed differently.
 *
 * These carry the tool as a subject, because the honest fix for a recurring
 * one is usually "the manifest is wrong or missing", not "trust this address".
 */
const TOOL_BEARING: ReadonlySet<string> = new Set([
  "coverage",
  "undeclared",
  "magnitude",
  "scope",
]);

export function subjectsOf(finding: Finding): readonly Subject[] {
  const detail = finding.detail;
  const subjects: Subject[] = [];

  const add = (kind: SubjectKind, value: string | null): void => {
    if (value === null) return;
    if (subjects.some((s) => s.kind === kind && s.value === value)) return;
    subjects.push({ kind, value });
  };

  // Where value went. The only address an allowlist is ever about: an address
  // the transaction merely read from is not where the money goes.
  add("address", text(detail, "counterparty"));

  // A permitted effect on an account the call never named. Here the account
  // itself IS the thing a reviewer recognises or does not.
  if (finding.check === "scope") add("address", text(detail, "account"));

  if (finding.rule === "undeclared.program_not_allowed")
    add("program", text(detail, "program"));

  if (TOOL_BEARING.has(finding.check)) add("tool", text(detail, "tool"));

  return subjects;
}
