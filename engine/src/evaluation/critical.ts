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
import type { ToolManifest } from "../types/manifest.js";
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
export function alwaysCriticalFindings(
  set: EffectSet,
  manifest: ToolManifest | null = null,
): readonly Finding[] {
  const findings: Finding[] = [];
  // A manifest that REQUIRES an effect authorises it. Without this, a tool
  // whose entire purpose is granting a delegate could never be allowed, and
  // the safety net would be indistinguishable from a blanket ban. What the
  // manifest does not lift is the bound: the magnitude check still compares
  // the allowance against what the tool call declared, and provenance still
  // asks who the delegate is.
  const authorised = new Set(
    (manifest?.must ?? []).map((pattern) => pattern.type),
  );

  for (const effect of set.effects) {
    if (authorised.has(effect.type)) continue;
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

  // An address the transaction uses and VETO cannot even name. This is the
  // one that matters: not observing a readonly account is normal, not knowing
  // an account exists is not.
  if (set.coverage.blindSpots.length > 0) {
    findings.push({
      check: "coverage",
      severity: "high",
      rule: "coverage.unresolved_lookup_table",
      detail: {
        blindSpots: set.coverage.blindSpots.length,
        sample: set.coverage.blindSpots.slice(0, 3),
        note: "accounts behind an unreadable lookup table: their effects cannot be seen",
      },
    });
  }

  // Readonly accounts are expected to go unobserved, so this is recorded for
  // the audit trail rather than raised as a concern. A check that fires on
  // every ordinary transaction is a check the customer switches off.
  if (!coverageIsComplete(set.coverage)) {
    findings.push({
      check: "coverage",
      severity: "low",
      rule: "coverage.accounts_unobserved",
      detail: {
        unobserved: set.coverage.unobserved.length,
        referenced: set.coverage.referenced.length,
        sample: set.coverage.unobserved.slice(0, 5),
        note: "expected for readonly accounts, which cannot change state",
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
