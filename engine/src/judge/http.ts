/**
 * A judge reached over HTTP. This is where the customer's model plugs in.
 *
 * The service receives the JudgeInput as JSON and answers with a JudgeOpinion:
 *
 *   POST <url>
 *   { record, effects, userGoal, toolCall, chunks }
 *   -> { tighten: null | { to: "flag" | "deny", reason }, model }
 *
 * Anything else -- a timeout, a 500, a body that does not validate -- is an
 * unavailable judge, and the deterministic verdict stands. The adapter never
 * throws.
 */
import { postJson, type HttpOptions } from "../adapters/http.js";
import {
  judgeOpinionSchema,
  type Judge,
  type JudgeInput,
  type JudgeResult,
} from "../types/judge.js";

export class HttpJudge implements Judge {
  readonly name: string;

  constructor(
    private readonly options: HttpOptions & { readonly name?: string },
  ) {
    this.name = options.name ?? "http";
  }

  async judge(input: JudgeInput): Promise<JudgeResult> {
    const result = await postJson(this.options, input, judgeOpinionSchema);
    return result.ok
      ? { ok: true, opinion: result.value, latencyMs: result.latencyMs }
      : { ok: false, reason: result.reason, latencyMs: result.latencyMs };
  }
}
