/**
 * Effects that are never acceptable without a manifest saying otherwise.
 *
 * This is the safety net under everything else. Checks A and B need a tool
 * manifest to compare against; when a tool has none -- a new tool, a tool
 * nobody wrote a manifest for, a manifest with a gap -- those checks simply do
 * not run. Something still has to.
 *
 * The set is deliberately tiny. It is not "effects that look dangerous", it is
 * the handful that cannot be explained by ordinary activity: giving away the
 * account, giving away authority over an asset, or handing someone unlimited
 * spending power. Measured against 380 real mainnet transactions, not one of
 * them produced any of these.
 *
 * Degrade, never open: missing a manifest must not mean missing everything.
 */
import { UNLIMITED_ALLOWANCE } from "../normalization/spl.js";
import {
  coverageIsComplete,
  type Effect,
  type EffectSet,
} from "../types/effects.js";
import type { Finding } from "../types/verdict.js";

/** A delegate this large can move the whole balance, now and indefinitely. */
export function isUnlimitedDelegate(effect: Effect): boolean {
  return (
    effect.type === "DELEGATE_GRANT" &&
    effect.amount !== undefined &&
    effect.amount >= UNLIMITED_ALLOWANCE
  );
}

function finding(
  rule: string,
  detail: Readonly<Record<string, unknown>>,
): Finding {
  return { check: "undeclared", severity: "critical", rule, detail };
}

/**
 * Findings that hold with no manifest, no tool call and no user goal.
 *
 * Everything here is derived from the EffectSet alone, which is why it works
 * even when the rest of the evaluation cannot run.
 */
export function alwaysCriticalFindings(set: EffectSet): readonly Finding[] {
  const findings: Finding[] = [];

  for (const effect of set.effects) {
    if (isUnlimitedDelegate(effect)) {
      findings.push(
        finding("always_critical.unlimited_delegate", {
          account: effect.account,
          delegate: effect.counterparty ?? null,
          mint: effect.mint ?? null,
          amount: (effect.amount ?? 0n).toString(),
          note: "u64::MAX allowance: the delegate can move the entire balance, indefinitely",
        }),
      );
      continue;
    }
    if (effect.type === "AUTHORITY_CHANGE") {
      findings.push(
        finding("always_critical.authority_change", {
          account: effect.account,
          authorityKind: effect.authorityKind ?? null,
          newAuthority: effect.counterparty ?? null,
        }),
      );
      continue;
    }
    if (effect.type === "OWNER_CHANGE") {
      findings.push(
        finding("always_critical.owner_change", {
          account: effect.account,
          newOwner: effect.counterparty ?? null,
        }),
      );
    }
  }

  return findings;
}

/**
 * Findings about what the evaluation could NOT see.
 *
 * These are not effects; they are the absence of evidence. They exist because
 * a blind spot has to cost something, or the cheapest way to pass evaluation
 * would be to make it impossible.
 */
export function coverageFindings(set: EffectSet): readonly Finding[] {
  const findings: Finding[] = [];

  if (set.simulation.status === "unavailable") {
    findings.push({
      check: "coverage",
      severity: "critical",
      rule: "coverage.simulation_unavailable",
      detail: { reason: set.simulation.reason },
    });
  }

  if (set.simulation.status === "failed") {
    // The transaction would fail on-chain, so there is nothing to evaluate.
    // Not dangerous, but the evaluation did not happen either.
    findings.push({
      check: "coverage",
      severity: "low",
      rule: "coverage.transaction_would_fail",
      detail: { error: set.simulation.error },
    });
  }

  if (!coverageIsComplete(set.coverage)) {
    findings.push({
      check: "coverage",
      severity: "medium",
      rule: "coverage.accounts_unobserved",
      detail: {
        unobserved: set.coverage.unobserved.length,
        referenced: set.coverage.referenced.length,
        sample: set.coverage.unobserved.slice(0, 5),
        note: "a readonly account cannot change state; an unresolved lookup table is a real blind spot",
      },
    });
  }

  if (
    set.slot !== null &&
    set.baselineSlot !== null &&
    set.slot !== set.baselineSlot
  ) {
    findings.push({
      check: "coverage",
      severity: "low",
      rule: "coverage.baseline_slot_gap",
      detail: {
        slot: set.slot,
        baselineSlot: set.baselineSlot,
        note: "the two sides of the diff come from different moments",
      },
    });
  }

  return findings;
}
