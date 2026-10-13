/**
 * The judge: the one LLM allowed near the decision, and what it may do.
 *
 * The customer's flow puts an "AI as judge" between the deterministic verdict
 * and the wallet. That is compatible with "no LLM in the decision path" under
 * exactly one condition, and this file makes the condition a TYPE rather than
 * a convention: the judge can only TIGHTEN. `tighten` is either null or a
 * move to flag or deny. There is no way to express "allow" here, so a judge
 * that has been talked into allowing something has nothing to say it with.
 *
 * Why the asymmetry is safe: a judge that wrongly denies costs the customer
 * one transaction, which they see and can override through the review queue.
 * A judge that wrongly allows costs the wallet. The two failure modes are not
 * the same size, and the type reflects that.
 *
 * What the judge receives is the structured record plus the context chunks
 * with their labels. It does receive untrusted text -- the judge is theirs
 * and judging the prompt is what they built it for -- and that is acceptable
 * only because of the asymmetry above: the worst an attacker can do through
 * that text is make the judge deny.
 *
 * It does NOT simulate. It receives the EffectSet the normaliser produced.
 * Two simulations at different slots can disagree, and a system with two
 * sources of truth about what a transaction does has none.
 */
import { z } from "zod";
import type { ContextChunk, ToolCall } from "./context.js";
import type { EffectSet } from "./effects.js";
import type { ActionRecord } from "./record.js";

export const judgeOpinionSchema = z.object({
  /** null means the judge has nothing to add. It cannot say "allow". */
  tighten: z
    .object({
      to: z.enum(["flag", "deny"]),
      reason: z.string().min(1),
    })
    .nullable(),
  /** Model and version, so an opinion is attributable months later. */
  model: z.string().min(1),
});
export type JudgeOpinion = z.infer<typeof judgeOpinionSchema>;

export interface JudgeInput {
  /** The verdict and findings, as recorded. */
  readonly record: ActionRecord;
  /** What the transaction does. From our simulation, never the judge's. */
  readonly effects: EffectSet;
  readonly userGoal: string;
  readonly toolCall: ToolCall;
  /** Every chunk, with its stamp and any guard label. Nothing removed. */
  readonly chunks: readonly ContextChunk[];
}

/**
 * How the judge is reached, or why it was not.
 *
 * Unavailability is a RESULT, not an exception: the deterministic verdict
 * stands, and the record says the judge was not consulted. Silently skipping
 * a layer the operator believes is there is the failure this guards against.
 */
export type JudgeResult =
  | { readonly ok: true; readonly opinion: JudgeOpinion; readonly latencyMs: number }
  | { readonly ok: false; readonly reason: string; readonly latencyMs: number };

export interface Judge {
  /** A name for the record. */
  readonly name: string;
  judge(input: JudgeInput): Promise<JudgeResult>;
}
