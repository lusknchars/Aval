/**
 * Check E: what the input classifier said about the text an address came from.
 *
 * Provenance answers WHERE an address came from. This answers whether the text
 * it came from LOOKED LIKE AN INSTRUCTION -- which is a different question,
 * and the one provenance cannot ask. A trusted source can carry an injection;
 * a page the customer allowlisted can be compromised. Provenance alone rates
 * that `low`. The label is what says otherwise.
 *
 * The classifier is external and VETO never runs it. It arrives as a label on
 * the chunk, stamped at capture, and this file only reads it. Two rules:
 *
 *  - The label RAISES, never lowers. A chunk labelled benign changes nothing:
 *    a classifier that could downgrade a finding would be a classifier an
 *    attacker tunes their text against.
 *  - A label only matters when the chunk CONTRIBUTED something. A page that
 *    reads like an injection and named no address that the transaction then
 *    used is a fact for the record, not a finding that moves the decision.
 *    Firing on every labelled page would make the operator turn the label
 *    off, and then the one that mattered goes with it.
 *
 * An address the human typed is theirs even if a labelled page repeats it.
 * That is provenance's ordering, and it holds here too.
 */
import { classifyAddress, type ProvenanceConfig } from "./provenance.js";
import type { ActionContext } from "../types/context.js";
import { counterparties, type EffectSet } from "../types/effects.js";
import type { Finding } from "../types/verdict.js";

/** Origins where the human, or the operator, already vouched for the address. */
const VOUCHED = new Set(["own_account", "user_goal", "allowlist"]);

export function contentFindings(
  set: EffectSet,
  context: ActionContext,
  config: ProvenanceConfig,
): readonly Finding[] {
  const findings: Finding[] = [];

  const labelled = context.contextChunks
    .map((chunk, index) => ({ chunk, index }))
    .filter(
      ({ chunk }) =>
        chunk.guard !== undefined && chunk.guard.label !== "benign",
    );
  if (labelled.length === 0) return findings;

  const contributed = new Set<number>();

  for (const address of counterparties(set)) {
    const verdict = classifyAddress(address, context, config);
    if (VOUCHED.has(verdict.origin)) continue;

    const from = labelled.filter(({ index }) =>
      verdict.foundInChunks.includes(index),
    );
    if (from.length === 0) continue;
    for (const { index } of from) contributed.add(index);

    findings.push({
      check: "content",
      severity: "critical",
      rule: "content.labelled_source",
      detail: {
        counterparty: address,
        origin: verdict.origin,
        chunks: from.map(({ chunk, index }) => ({
          index,
          label: chunk.guard?.label ?? null,
          score: chunk.guard?.score ?? null,
          model: chunk.guard?.model ?? null,
          source: chunk.source ?? null,
          via: chunk.via ?? null,
        })),
      },
    });
  }

  // Labelled, and contributed nothing the transaction used. Kept visible at
  // the lowest severity: it never moves the decision, and it is the count
  // that tells an operator whether their classifier fires on everything.
  const idle = labelled.filter(({ index }) => !contributed.has(index));
  if (idle.length > 0) {
    findings.push({
      check: "content",
      severity: "low",
      rule: "content.labelled_input",
      detail: {
        chunks: idle.length,
        labels: idle.map(({ chunk }) => chunk.guard?.label ?? null),
        note: "input the classifier labelled, which contributed no address this transaction uses",
      },
    });
  }

  return findings;
}
