/**
 * Comparing what a tool is allowed to cause against what the transaction
 * actually does.
 *
 * This is the check that needs no interpretation at all. Both sides are
 * already structured -- the manifest in the effect vocabulary, the EffectSet
 * in the same one -- so the comparison is set membership, not semantics.
 *
 * It is also the check that shows why a static policy cannot work:
 * DELEGATE_GRANT is forbidden in `transfer` and in `swap`, and mandatory in
 * `approve`. The same effect, critical in one context and expected in the
 * other. A global rule can only say "delegates allowed" or "delegates
 * forbidden", and both answers are wrong.
 */
import type { ToolCall } from "../types/context.js";
import type { Effect, EffectSet } from "../types/effects.js";
import {
  isArgRef,
  validateReferences,
  type ArgRef,
  type DecimalsByMint,
  type EffectPattern,
  type ToolManifest,
} from "../types/manifest.js";
import { scopeFindings } from "./scope.js";
import type { Finding, Severity } from "../types/verdict.js";

/**
 * How bad an effect is when nothing declared it.
 *
 * Losing authority or handing over spending power cannot be an accident.
 * Losing the account is nearly as bad. A balance change nobody declared is
 * worth attention but is often fee or rent.
 */
const SEVERITY_BY_EFFECT: Readonly<Record<Effect["type"], Severity>> = {
  DELEGATE_GRANT: "critical",
  AUTHORITY_CHANGE: "critical",
  OWNER_CHANGE: "critical",
  ACCOUNT_CLOSE: "high",
  BALANCE_DECREASE: "medium",
  BALANCE_INCREASE: "low",
  ACCOUNT_CREATE: "low",
  PROGRAM_INVOKE: "low",
};

/** A pattern with every `arg:` reference replaced by the tool call's value. */
interface ResolvedPattern {
  readonly type: Effect["type"];
  readonly account: string | undefined;
  readonly owner: string | undefined;
  readonly mint: string | undefined;
  readonly counterparty: string | undefined;
  readonly maxAmount: bigint | undefined;
  readonly tolerance: number | undefined;
  readonly unresolved: readonly string[];
}

function resolveText(
  value: string | ArgRef | undefined,
  args: Record<string, unknown>,
): {
  value: string | undefined;
  unresolved: string | null;
} {
  if (value === undefined) return { value: undefined, unresolved: null };
  if (!isArgRef(value)) return { value, unresolved: null };
  const name = value.slice("arg:".length);
  const found = args[name];
  if (typeof found === "string") return { value: found, unresolved: null };
  // The manifest points at an argument the tool call did not provide, or
  // provided with the wrong type. The check cannot run, and saying so is the
  // whole point: silence here would look like approval.
  return { value: undefined, unresolved: value };
}

/**
 * Amounts arrive from a tool call in whatever unit the tool speaks, and
 * effects are always raw. A manifest that declares `decimal` needs the mint's
 * decimals to compare; without them the check degrades instead of guessing.
 */
function resolveAmount(
  pattern: EffectPattern,
  args: Record<string, unknown>,
  mint: string | undefined,
  decimals: DecimalsByMint,
): { value: bigint | undefined; unresolved: string | null } {
  const raw = pattern.maxAmount;
  if (raw === undefined) return { value: undefined, unresolved: null };
  if (typeof raw === "bigint") return { value: raw, unresolved: null };

  const name = raw.slice("arg:".length);
  const given = args[name];
  const asText =
    typeof given === "number"
      ? String(given)
      : typeof given === "string"
        ? given
        : null;
  if (asText === null || !/^\d+(\.\d+)?$/.test(asText)) {
    return { value: undefined, unresolved: raw };
  }
  if (pattern.unit === "raw")
    return { value: BigInt(asText.split(".")[0] ?? "0"), unresolved: null };

  const places = mint === undefined ? undefined : decimals.get(mint);
  if (places === undefined)
    return {
      value: undefined,
      unresolved: `${raw} (decimals for ${mint ?? "?"} unknown)`,
    };

  const [whole = "0", fraction = ""] = asText.split(".");
  if (fraction.length > places)
    return {
      value: undefined,
      unresolved: `${raw} (more precision than the mint)`,
    };
  return {
    value: BigInt(whole + fraction.padEnd(places, "0")),
    unresolved: null,
  };
}

function resolvePattern(
  pattern: EffectPattern,
  args: Record<string, unknown>,
  decimals: DecimalsByMint,
): ResolvedPattern {
  const account = resolveText(pattern.account, args);
  const owner = resolveText(pattern.owner, args);
  const mint = resolveText(pattern.mint, args);
  const counterparty = resolveText(pattern.counterparty, args);
  const amount = resolveAmount(pattern, args, mint.value, decimals);
  const unresolved = [
    account.unresolved,
    owner.unresolved,
    mint.unresolved,
    counterparty.unresolved,
    amount.unresolved,
  ].filter((entry): entry is string => entry !== null);
  return {
    type: pattern.type,
    account: account.value,
    owner: owner.value,
    mint: mint.value,
    counterparty: counterparty.value,
    maxAmount: amount.value,
    tolerance: pattern.tolerance,
    unresolved,
  };
}

function matches(effect: Effect, pattern: ResolvedPattern): boolean {
  if (effect.type !== pattern.type) return false;
  if (pattern.account !== undefined && effect.account !== pattern.account)
    return false;
  if (pattern.owner !== undefined && effect.owner !== pattern.owner)
    return false;
  if (pattern.mint !== undefined && effect.mint !== pattern.mint) return false;
  if (
    pattern.counterparty !== undefined &&
    effect.counterparty !== pattern.counterparty
  )
    return false;
  return true;
}

/** The ceiling an effect may reach, once slack for slippage and fees is added. */
function ceilingOf(pattern: ResolvedPattern): bigint | undefined {
  if (pattern.maxAmount === undefined) return undefined;
  const tolerance = pattern.tolerance ?? 0;
  if (tolerance === 0) return pattern.maxAmount;
  // Integer arithmetic on purpose: a float here would reintroduce exactly the
  // precision loss every amount in this system is bigint to avoid.
  const basisPoints = BigInt(Math.round(tolerance * 10_000));
  return pattern.maxAmount + (pattern.maxAmount * basisPoints) / 10_000n;
}

export interface ManifestCheckInput {
  readonly effects: EffectSet;
  /** null when no manifest exists for this tool. */
  readonly manifest: ToolManifest | null;
  readonly toolCall: ToolCall;
  /** Decimals per mint, for manifests that declare amounts in decimal units. */
  readonly decimals?: DecimalsByMint;
}

/**
 * Checks A (undeclared effect) and B (magnitude).
 *
 * With no manifest, neither can run. That is reported rather than passed over:
 * the safety net and provenance still work, and the gap is named so nobody
 * mistakes "nothing fired" for "nothing was checked".
 */
export function manifestFindings(
  input: ManifestCheckInput,
): readonly Finding[] {
  const findings: Finding[] = [];
  const { manifest } = input;

  if (manifest === null) {
    return [
      {
        check: "coverage",
        severity: "medium",
        rule: "coverage.no_manifest",
        detail: {
          tool: input.toolCall.name,
          note: "checks A and B did not run; only the safety net and provenance apply",
        },
      },
    ];
  }

  const broken = validateReferences(manifest);
  if (broken.length > 0) {
    findings.push({
      check: "coverage",
      severity: "high",
      rule: "coverage.manifest_invalid",
      detail: {
        tool: manifest.tool,
        problems: broken.map((p) => `${p.field}: ${p.reason}`),
      },
    });
  }

  // Nothing ran, so there are no effects to compare against. Reporting every
  // declared effect as missing would be true and useless: it says the
  // transaction did not do what it promised, when the fact is that it did not
  // do anything at all. Coverage already carries that, at the severity it
  // deserves -- low for a transaction that would fail, critical for a
  // simulation that never happened.
  if (input.effects.simulation.status !== "executed") {
    findings.push({
      check: "coverage",
      severity: "low",
      rule: "coverage.manifest_not_compared",
      detail: {
        tool: manifest.tool,
        simulation: input.effects.simulation.status,
      },
    });
    return findings;
  }

  const decimals: DecimalsByMint = input.decimals ?? new Map();
  const args = input.toolCall.args;
  const must = manifest.must.map((p) => resolvePattern(p, args, decimals));
  const may = manifest.may.map((p) => resolvePattern(p, args, decimals));
  const forbidden = new Set(manifest.mustNot);

  // A reference that points nowhere means the comparison silently matches
  // nothing. That is the seam between our manifest and the customer's real
  // tool, and it has to cost something.
  for (const pattern of [...must, ...may]) {
    for (const reference of pattern.unresolved) {
      findings.push({
        check: "coverage",
        severity: "medium",
        rule: "coverage.unresolved_reference",
        detail: { tool: manifest.tool, reference, args: Object.keys(args) },
      });
    }
  }

  /**
   * What each `must` pattern actually matched.
   *
   * A TOTAL, not one comparison per effect. Checking each effect on its own
   * lets a transaction split a drain across two accounts of the same mint:
   * declared 100, two decreases of 100 each, both under the ceiling, and the
   * magnitude check never fires. The declared amount bounds the operation,
   * not each leg of it.
   */
  const matchedMust = new Map<
    number,
    { total: bigint; accounts: string[] }
  >();
  /**
   * Effects the manifest allows. They still have to be on accounts this tool
   * call authorised, which is what the scope check asks at the end.
   */
  const permitted: Effect[] = [];

  for (const effect of input.effects.effects) {
    if (forbidden.has(effect.type)) {
      findings.push({
        check: "undeclared",
        severity: SEVERITY_BY_EFFECT[effect.type],
        rule: `mustNot.${effect.type}`,
        detail: {
          tool: manifest.tool,
          account: effect.account,
          counterparty: effect.counterparty ?? null,
          amount: effect.amount === undefined ? null : effect.amount.toString(),
        },
      });
      continue;
    }

    const mustIndex = must.findIndex((pattern) => matches(effect, pattern));
    if (mustIndex >= 0) {
      const seen = matchedMust.get(mustIndex) ?? { total: 0n, accounts: [] };
      if (effect.amount !== undefined) seen.total += effect.amount;
      seen.accounts.push(effect.account);
      matchedMust.set(mustIndex, seen);
      permitted.push(effect);
      continue;
    }

    if (may.some((pattern) => matches(effect, pattern))) {
      permitted.push(effect);
      continue;
    }

    if (effect.type === "PROGRAM_INVOKE") {
      const allowlist = manifest.programAllowlist;
      if (
        allowlist !== undefined &&
        !allowlist.includes(effect.program ?? effect.account)
      ) {
        findings.push({
          check: "undeclared",
          severity: "medium",
          rule: "undeclared.program_not_allowed",
          detail: {
            tool: manifest.tool,
            program: effect.program ?? effect.account,
          },
        });
      }
      continue;
    }

    findings.push({
      check: "undeclared",
      severity: SEVERITY_BY_EFFECT[effect.type],
      rule: `undeclared.${effect.type}`,
      detail: {
        tool: manifest.tool,
        account: effect.account,
        counterparty: effect.counterparty ?? null,
        amount: effect.amount === undefined ? null : effect.amount.toString(),
      },
    });
  }

  // Check B, against the sum of everything the pattern matched.
  for (const [index, seen] of matchedMust) {
    const pattern = must[index];
    if (pattern === undefined) continue;
    const ceiling = ceilingOf(pattern);
    if (ceiling === undefined || seen.total <= ceiling) continue;
    findings.push({
      check: "magnitude",
      severity: "high",
      rule: "magnitude.above_declared",
      detail: {
        tool: manifest.tool,
        accounts: [...new Set(seen.accounts)],
        legs: seen.accounts.length,
        declared: (pattern.maxAmount ?? 0n).toString(),
        tolerance: pattern.tolerance ?? 0,
        ceiling: ceiling.toString(),
        observed: seen.total.toString(),
      },
    });
  }

  // The tool said it would do something and the transaction does not do it.
  must.forEach((pattern, index) => {
    if (matchedMust.has(index)) return;
    findings.push({
      check: "undeclared",
      severity: "high",
      rule: `must.missing.${pattern.type}`,
      detail: {
        tool: manifest.tool,
        account: pattern.account ?? null,
        mint: pattern.mint ?? null,
      },
    });
  });

  // Check on WHERE, after the checks on what. Only permitted effects are
  // passed: anything else is already reported, with its account, as
  // undeclared.
  findings.push(
    ...scopeFindings(
      permitted,
      manifest,
      input.toolCall,
      input.effects.feePayer ?? "",
    ),
  );

  return findings;
}
