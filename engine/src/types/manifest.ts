/**
 * Tool manifest: the left-hand side of the comparison.
 *
 * Declares, in the same closed effect vocabulary, what a tool legitimately
 * causes. Hand-written once, versioned alongside the code.
 *
 * The point no static policy reaches: DELEGATE_GRANT is forbidden in
 * `transfer` and in `swap`, and mandatory in `approve`. The same effect is
 * critical in one context and expected in another -- the manifest is where
 * that difference fits.
 */
import { z } from "zod";
import { effectTypeSchema, type EffectType } from "./effects.js";

/** Reference to a tool call argument. Resolved at evaluation time. */
export type ArgRef = `arg:${string}`;

const ARG_REF_PATTERN = /^arg:[A-Za-z_][A-Za-z0-9_]*$/;

export function isArgRef(value: unknown): value is ArgRef {
  return typeof value === "string" && ARG_REF_PATTERN.test(value);
}

export const argRefSchema = z.custom<ArgRef>(isArgRef, {
  error: 'invalid reference: use the form "arg:argumentName"',
});

/**
 * Declared type of a tool argument.
 *
 * It exists so resolution can FAIL EXPLICITLY when the agent sends the wrong
 * type, instead of comparing garbage against garbage.
 */
export const argTypeSchema = z.enum([
  "address", // base58 public key
  "mint", // SPL mint, or "SOL"
  "amount", // numeric token value
  "text",
]);
export type ArgType = z.infer<typeof argTypeSchema>;

/**
 * The unit the tool call's amount is expressed in.
 *
 * THIS FIELD PREVENTS THE MOST OBVIOUS FALSE POSITIVE IN THE SYSTEM. A tool
 * call says `amount: 10` (USDC); the simulated effect says `10000000n` (raw
 * units). Comparing them directly reports "declared 10, moved 10 million" on
 * every legitimate transfer. `decimal` requires converting with the mint's
 * decimals before comparing; `raw` compares directly.
 */
export const amountUnitSchema = z.enum(["raw", "decimal"]);
export type AmountUnit = z.infer<typeof amountUnitSchema>;

/** Decimals per mint, supplied by the normalizer. Without it, `decimal` cannot compare. */
export type DecimalsByMint = ReadonlyMap<string, number>;

/**
 * Maximum slack accepted in a manifest. Above this it stops being slippage.
 * A tool that legitimately needs more requires an explicit exception.
 */
export const MAX_TOLERANCE = 0.1;

/** An expected effect pattern. Absent fields mean "does not constrain". */
export const effectPatternSchema = z.object({
  type: effectTypeSchema,
  account: z.union([argRefSchema, z.string()]).optional(),
  mint: z.union([argRefSchema, z.string()]).optional(),
  counterparty: z.union([argRefSchema, z.string()]).optional(),
  maxAmount: z.union([argRefSchema, z.bigint()]).optional(),
  minAmount: z.union([argRefSchema, z.bigint()]).optional(),
  /**
   * Accepted fraction of slack, for slippage and fees. 0.03 = 3%.
   *
   * Capped at MAX_TOLERANCE to catch `0.3` typed in place of `0.03`. Too much
   * slack means the skim fits inside the tolerance -- nobody steals 500, they
   * steal 3% of every operation, and the magnitude check never fires. The
   * number is CALIBRATION, not a logical consequence: revisit with real data.
   */
  tolerance: z.number().min(0).max(MAX_TOLERANCE).optional(),
  /** Required when maxAmount/minAmount comes from an argument. */
  unit: amountUnitSchema.optional(),
});
export type EffectPattern = z.infer<typeof effectPatternSchema>;

/**
 * Which accounts the tool may touch.
 * An account touched outside the scope is a high-severity finding.
 */
export const accountScopeSchema = z.enum([
  "args_only", // only the accounts named in the arguments
  "args_plus_derived", // plus PDAs and ATAs derived from them
  "open", // unrestricted; use only when unavoidable
]);
export type AccountScope = z.infer<typeof accountScopeSchema>;

export const toolManifestSchema = z.object({
  tool: z.string().min(1),
  /** Manifest version. Feeds the policyVersion of every verdict. */
  version: z.string().min(1),

  /** The arguments this tool has. Every ArgRef must point at one of them. */
  args: z.record(z.string(), argTypeSchema),

  must: z.array(effectPatternSchema), // has to happen
  may: z.array(effectPatternSchema), // may happen
  mustNot: z.array(effectTypeSchema), // presence = immediate violation

  accountScope: accountScopeSchema,
  programAllowlist: z.array(z.string()).optional(),
});
export type ToolManifest = z.infer<typeof toolManifestSchema>;

/** A structural problem found in a manifest, before any evaluation. */
export interface ManifestProblem {
  readonly field: string;
  readonly reason: string;
}

function patternReferences(
  pattern: EffectPattern,
): { field: string; ref: ArgRef }[] {
  const found: { field: string; ref: ArgRef }[] = [];
  const candidates: [string, unknown][] = [
    ["account", pattern.account],
    ["mint", pattern.mint],
    ["counterparty", pattern.counterparty],
    ["maxAmount", pattern.maxAmount],
    ["minAmount", pattern.minAmount],
  ];
  for (const [field, value] of candidates) {
    if (isArgRef(value)) found.push({ field, ref: value });
  }
  return found;
}

const EXPECTED_ARG_TYPE: Readonly<Record<string, ArgType>> = {
  account: "address",
  counterparty: "address",
  mint: "mint",
  maxAmount: "amount",
  minAmount: "amount",
};

/**
 * Checks a manifest's internal coherence BEFORE using it.
 *
 * A typo in `arg:form` has to blow up when the manifest loads, not months
 * later, in the middle of an attack, as a comparison that silently matches
 * nothing.
 */
export function validateReferences(
  manifest: ToolManifest,
): readonly ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  const declared = manifest.args;

  const check = (patterns: readonly EffectPattern[], origin: string): void => {
    patterns.forEach((pattern, i) => {
      for (const { field, ref } of patternReferences(pattern)) {
        const name = ref.slice("arg:".length);
        const declaredType = declared[name];
        const where = `${origin}[${i}].${field}`;
        if (declaredType === undefined) {
          problems.push({
            field: where,
            reason: `"${ref}" is not declared in args`,
          });
          continue;
        }
        const expected = EXPECTED_ARG_TYPE[field];
        if (expected !== undefined && declaredType !== expected) {
          problems.push({
            field: where,
            reason: `"${ref}" is ${declaredType}, but ${field} requires ${expected}`,
          });
        }
      }
      // An amount coming from an argument with no declared unit would compare
      // 10 (USDC) against 10000000n (raw) -- a guaranteed false positive.
      const amountFromRef =
        isArgRef(pattern.maxAmount) || isArgRef(pattern.minAmount);
      if (amountFromRef && pattern.unit === undefined) {
        problems.push({
          field: `${origin}[${i}].unit`,
          reason: "amount comes from an argument but no unit was declared",
        });
      }
    });
  };

  check(manifest.must, "must");
  check(manifest.may, "may");

  // An effect cannot be mandatory and forbidden at the same time.
  const forbidden = new Set<EffectType>(manifest.mustNot);
  manifest.must.forEach((pattern, i) => {
    if (forbidden.has(pattern.type)) {
      problems.push({
        field: `must[${i}].type`,
        reason: `${pattern.type} is also in mustNot`,
      });
    }
  });

  return problems;
}
