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
import type { Finding, Severity, Thresholds } from "../types/verdict.js";

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
  severity: Severity = "critical",
): Finding {
  return { check: "undeclared", severity, rule, detail };
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
    // High rather than critical: a freeze DENIES access, it does not hand
    // control to anybody, and a token issuer's agent freezes legitimately --
    // which its manifest is then what authorises.
    if (effect.type === "ACCOUNT_FREEZE") {
      findings.push(
        finding(
          "always_critical.account_frozen",
          {
            account: effect.account,
            owner: effect.owner ?? null,
            mint: effect.mint ?? null,
            note: "the owner can no longer move anything in this account, and no token moved so no amount check sees it",
          },
          "high",
        ),
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
 * The fee, which no manifest ever looks at.
 *
 * The diff takes the fee out of the payer's balance change on purpose: it is
 * the cost of asking, not part of what was asked for, and leaving it in made
 * every legitimate transfer look slightly larger than the tool call declared.
 * The consequence is that the fee is then bounded by nothing at all, and a
 * priority fee is an arbitrary amount of SOL leaving the wallet. It does not
 * matter that it goes to validators rather than to an attacker -- the wallet
 * is empty either way.
 */
export function feeFindings(
  set: EffectSet,
  thresholds: Thresholds,
): readonly Finding[] {
  if (set.fee === null || set.fee <= thresholds.maxFeeLamports) return [];
  return [
    {
      check: "magnitude",
      severity: "high",
      rule: "magnitude.fee_above_ceiling",
      detail: {
        fee: set.fee.toString(),
        ceiling: thresholds.maxFeeLamports.toString(),
        payer: set.feePayer,
        note: "the fee is excluded from the effects by design, so nothing else bounds it",
      },
    },
  ];
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
  // Bytes VETO does not read, on accounts it did read. A transfer hook or a
  // permanent delegate lives there, and neither would ever become an effect.
  // FLAG rather than DENY because most extensions are benign metadata --
  // which is calibration, not a consequence of anything.
  if (set.coverage.tokenExtensions.length > 0) {
    findings.push({
      check: "coverage",
      severity: "medium",
      rule: "coverage.token_extensions",
      detail: {
        accounts: set.coverage.tokenExtensions.length,
        sample: set.coverage.tokenExtensions.slice(0, 3),
        note: "Token-2022 extensions are not decoded: a transfer hook or permanent delegate here would be invisible",
      },
    });
  }

  // Bytes that changed and that nothing here reads. The diff producing no
  // effect for an account is not evidence that nothing happened to it.
  // `high` rather than `critical` because a stake account's data also
  // changes on an ordinary delegate or deactivate -- calibration, and it
  // has not been measured against real stake traffic.
  if (set.coverage.opaqueChanges.length > 0) {
    findings.push({
      check: "coverage",
      severity: "high",
      rule: "coverage.undecoded_authority_account",
      detail: {
        accounts: set.coverage.opaqueChanges.length,
        sample: set.coverage.opaqueChanges.slice(0, 3),
        note: "state changed in a program that holds authority and that VETO does not decode: a staker, withdrawer or upgrade authority could have moved unseen",
      },
    });
  }

  // A value that arrived already rounded. Small in relative terms -- it takes
  // more than nine million SOL to reach it -- but every amount in this system
  // is bigint precisely so that rounding never happens silently.
  if (set.coverage.inexactAmounts.length > 0) {
    findings.push({
      check: "coverage",
      severity: "low",
      rule: "coverage.inexact_lamports",
      detail: {
        accounts: set.coverage.inexactAmounts.length,
        sample: set.coverage.inexactAmounts.slice(0, 3),
        note: "lamports above 2^53-1 arrived rounded from the RPC: amounts derived from them are approximate",
      },
    });
  }

  // Bytes a token program owns that we could not read. High, because this is
  // the one gap where the missing information is the value itself.
  if (set.coverage.undecodable.length > 0) {
    findings.push({
      check: "coverage",
      severity: "high",
      rule: "coverage.undecodable_token_account",
      detail: {
        accounts: set.coverage.undecodable.length,
        sample: set.coverage.undecodable.slice(0, 3),
        note: "a token program owns this account and its contents could not be decoded: any balance, delegate or owner change in it is invisible",
      },
    });
  }

  // Writable accounts nobody looked at because the simulation would not
  // return that many. Anything they did is invisible.
  if (set.coverage.overSimulationLimit.length > 0) {
    findings.push({
      check: "coverage",
      severity: "high",
      rule: "coverage.account_limit_exceeded",
      detail: {
        unobserved: set.coverage.overSimulationLimit.length,
        sample: set.coverage.overSimulationLimit.slice(0, 3),
        note: "more writable accounts than one simulation returns post-state for: effects in these are invisible",
      },
    });
  }

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

  // A writable account VETO asked about and did not get back.
  //
  // Only when something actually ran. A failed or unavailable simulation has
  // no post-state for anything, and that fact already has its own finding --
  // reporting it twice made the tool look half-blind on a transaction it had
  // read perfectly, which is how the check earns being switched off.
  if (
    set.simulation.status === "executed" &&
    !coverageIsComplete(set.coverage)
  ) {
    findings.push({
      check: "coverage",
      severity: "low",
      rule: "coverage.accounts_unobserved",
      detail: {
        unobserved: set.coverage.unobserved.length,
        referenced: set.coverage.referenced.length,
        sample: set.coverage.unobserved.slice(0, 5),
        note: "writable accounts whose post-state never came back",
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
