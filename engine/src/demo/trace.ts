/**
 * The whole pipeline, made inspectable.
 *
 * This is not a view model bolted onto the side. Every field here is read
 * straight out of the objects the library already produces, converted to
 * something JSON can carry -- which for this project means bigint becomes a
 * decimal string, the same convention the fixtures use.
 *
 * It exists because "the verdict is explainable" is a claim, and a claim needs
 * a shape. If a stage cannot be rendered from the real objects, that stage is
 * not explainable, and the fix belongs in the stage rather than here.
 *
 * It is also the shape the gate will need to emit. A gate that blocks a
 * transaction has to hand back WHY, and this is why.
 */
import { classifyAddress, type ProvenanceConfig } from "../evaluation/provenance.js";
import { groupOf } from "./explain-pt.js";
import { counterparties, type Effect, type EffectSet } from "../types/effects.js";
import type { ActionContext } from "../types/context.js";
import { chunkIsTrusted } from "../types/context.js";
import type { ToolManifest } from "../types/manifest.js";
import {
  SEVERITIES,
  type Finding,
  type Severity,
  type Thresholds,
  type Verdict,
} from "../types/verdict.js";

const amount = (value: bigint | undefined): string | null =>
  value === undefined ? null : value.toString();

export interface TraceChunk {
  readonly text: string;
  readonly provenance: string;
  readonly source: string | null;
  /** Whether this chunk's origin counts as trusted for provenance. */
  readonly trusted: boolean;
}

export interface TraceEffect {
  readonly type: string;
  readonly account: string;
  readonly owner: string | null;
  readonly mint: string | null;
  readonly amount: string | null;
  readonly counterparty: string | null;
  readonly program: string | null;
  readonly authorityKind: string | null;
}

export interface TraceCounterparty {
  readonly address: string;
  readonly origin: string;
  readonly sources: readonly string[];
  /** null when this origin produces no finding at all. */
  readonly severity: Severity | null;
}

export interface TraceStep {
  readonly rule: string;
  readonly held: boolean;
  readonly detail: string;
}

/**
 * Where the tool call came from, which is a FACT rather than a guess.
 *
 * It used to be inferred -- "no manifest and no arguments means no agent" --
 * and that was inconsistent in a way that mattered: a mainnet transaction
 * whose shape the classifier happened to recognise came back with a full
 * verdict, and one it did not recognise came back as unattributed. Both have
 * exactly the same amount of agent behind them, which is none.
 *
 * `reconstructed` also carries a warning the interface owes the reader: when
 * the declaration is read back out of the transaction's own effects, checks A
 * and B are CIRCULAR. Of course the transaction does what the declaration
 * says; the declaration was copied from it. Provenance and the safety net
 * still mean something, and the manifest comparison does not.
 */
export type DeclarationSource =
  /** A model emitted this tool call. */
  | "agent"
  /** Read back out of the transaction's own effects. */
  | "reconstructed"
  /** Typed by a person, or taken from a recorded scenario's table. */
  | "manual"
  /** There is none. */
  | "none";

export interface Trace {
  readonly input: {
    readonly goal: string;
    readonly chunks: readonly TraceChunk[];
  };
  readonly declarationSource: DeclarationSource;
  readonly toolCall: {
    readonly name: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly manifest: {
      readonly tool: string;
      readonly version: string;
      readonly must: readonly string[];
      readonly may: readonly string[];
      readonly mustNot: readonly string[];
      readonly accountScope: string;
    } | null;
  };
  readonly transaction: {
    readonly messageDigest: string | null;
    readonly slot: number | null;
    readonly baselineSlot: number | null;
    readonly fee: string | null;
    readonly feePayer: string | null;
    readonly simulation: string;
    readonly simulationDetail: string | null;
  };
  readonly effects: readonly TraceEffect[];
  readonly coverage: Readonly<Record<string, readonly string[] | number>>;
  readonly counterparties: readonly TraceCounterparty[];
  readonly findings: readonly {
    readonly check: string;
    readonly severity: Severity;
    readonly rule: string;
    readonly detail: Readonly<Record<string, unknown>>;
    readonly group: "does" | "compare" | "read";
  }[];
  readonly decision: {
    readonly outcome: string;
    readonly counts: Readonly<Record<Severity, number>>;
    readonly thresholds: {
      readonly highsForDeny: number;
      readonly mediumsForFlag: number;
      readonly maxFeeLamports: string;
    };
    /** The ceiling rule, in order, with which line decided. */
    readonly steps: readonly TraceStep[];
  };
  readonly policyVersion: string;
  /**
   * What the transaction ACTUALLY did when it landed, when it already has.
   *
   * History, never a prediction, and never part of the verdict: AVAL judges
   * before signing, where this does not exist yet.
   */
  readonly history: {
    readonly slot: number;
    readonly succeeded: boolean;
    readonly lines: readonly string[];
  } | null;
}

function traceEffect(effect: Effect): TraceEffect {
  return {
    type: effect.type,
    account: effect.account,
    owner: effect.owner ?? null,
    mint: effect.mint ?? null,
    amount: amount(effect.amount),
    counterparty: effect.counterparty ?? null,
    program: effect.program ?? null,
    authorityKind: effect.authorityKind ?? null,
  };
}

function counts(findings: readonly Finding[]): Record<Severity, number> {
  const tally: Record<Severity, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  for (const finding of findings) tally[finding.severity]++;
  return tally;
}

/**
 * The combination rule, evaluated in order, with the first line that held.
 *
 * Rendering the rule rather than restating it is the point: whoever reads the
 * page sees the same four comparisons the code makes, and can see which one
 * produced the answer.
 */
function steps(
  findings: readonly Finding[],
  thresholds: Thresholds,
): readonly TraceStep[] {
  const tally = counts(findings);
  const ordered: readonly { rule: string; held: boolean; detail: string }[] = [
    {
      rule: "any critical → deny",
      held: tally.critical > 0,
      detail: `${tally.critical} critical`,
    },
    {
      rule: `${thresholds.highsForDeny}+ high → deny`,
      held: tally.high >= thresholds.highsForDeny,
      detail: `${tally.high} high`,
    },
    { rule: "any high → flag", held: tally.high > 0, detail: `${tally.high} high` },
    {
      rule: `${thresholds.mediumsForFlag}+ medium → flag`,
      held: tally.medium >= thresholds.mediumsForFlag,
      detail: `${tally.medium} medium`,
    },
    { rule: "otherwise → allow", held: true, detail: "nothing above low" },
  ];
  // Only the first line that holds decides; the rest are never consulted.
  let decided = false;
  return ordered.map((step) => {
    if (decided) return { ...step, held: false };
    if (step.held) decided = true;
    return step;
  });
}

export interface TraceInput {
  readonly declarationSource?: DeclarationSource;
  readonly history?: {
    readonly slot: number;
    readonly succeeded: boolean;
    readonly lines: readonly string[];
  } | null;
  readonly effects: EffectSet;
  readonly context: ActionContext;
  readonly verdict: Verdict;
  readonly manifest: ToolManifest | null;
  readonly provenance: ProvenanceConfig;
  readonly thresholds: Thresholds;
}

export function buildTrace(input: TraceInput): Trace {
  const { effects: set, context, verdict, manifest } = input;
  const severityByOrigin: Readonly<Record<string, Severity | null>> = {
    own_account: null,
    user_goal: null,
    allowlist: null,
    trusted_source: "low",
    known_counterparty: "medium",
    untrusted_source: "critical",
    unexplained: "critical",
  };

  return {
    input: {
      goal: context.userGoal,
      chunks: context.contextChunks.map((chunk) => ({
        text: chunk.text,
        provenance: chunk.provenance,
        source: chunk.source ?? null,
        trusted: chunkIsTrusted(chunk, input.provenance.trustedSources),
      })),
    },
    declarationSource: input.declarationSource ?? "manual",
    toolCall: {
      name: context.toolCall.name,
      args: context.toolCall.args,
      manifest:
        manifest === null
          ? null
          : {
              tool: manifest.tool,
              version: manifest.version,
              must: manifest.must.map((p) => p.type),
              may: manifest.may.map((p) => p.type),
              mustNot: [...manifest.mustNot],
              accountScope: manifest.accountScope,
            },
    },
    transaction: {
      messageDigest: verdict.messageDigest,
      slot: set.slot,
      baselineSlot: set.baselineSlot,
      fee: amount(set.fee ?? undefined),
      feePayer: set.feePayer,
      simulation: set.simulation.status,
      simulationDetail:
        set.simulation.status === "failed"
          ? set.simulation.error
          : set.simulation.status === "unavailable"
            ? set.simulation.reason
            : null,
    },
    effects: set.effects.map(traceEffect),
    coverage: {
      referenced: set.coverage.referenced.length,
      observed: set.coverage.observed.length,
      unobserved: set.coverage.unobserved.length,
      blindSpots: set.coverage.blindSpots,
      tokenExtensions: set.coverage.tokenExtensions,
      opaqueChanges: set.coverage.opaqueChanges,
      inexactAmounts: set.coverage.inexactAmounts,
      undecodable: set.coverage.undecodable,
      overSimulationLimit: set.coverage.overSimulationLimit,
    },
    // Every counterparty, including the ones that produce no finding: a page
    // that only shows problems cannot show that the good path was checked.
    counterparties: counterparties(set).map((address) => {
      const classified = classifyAddress(address, context, input.provenance);
      return {
        address,
        origin: classified.origin,
        sources: classified.sources,
        severity: severityByOrigin[classified.origin] ?? null,
      };
    }),
    findings: verdict.findings.map((finding) => ({
      check: finding.check,
      severity: finding.severity,
      rule: finding.rule,
      detail: finding.detail,
      // Which of the three questions this finding answers. See groupOf.
      group: groupOf(finding.rule, finding.check),
    })),
    decision: {
      outcome: verdict.decision,
      counts: counts(verdict.findings),
      thresholds: {
        highsForDeny: input.thresholds.highsForDeny,
        mediumsForFlag: input.thresholds.mediumsForFlag,
        maxFeeLamports: input.thresholds.maxFeeLamports.toString(),
      },
      steps: steps(verdict.findings, input.thresholds),
    },
    policyVersion: verdict.policyVersion,
    history: input.history ?? null,
  };
}

/** Severity order, so a page can sort without knowing the vocabulary. */
export const SEVERITY_ORDER: readonly Severity[] = SEVERITIES;
