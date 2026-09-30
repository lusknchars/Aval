/**
 * The input classifier, as the capture layer sees it.
 *
 * Prompt Guard today; anything that answers the same question tomorrow. It is
 * asked one thing about each chunk the moment it enters -- does this read like
 * an instruction? -- and its answer is written on the chunk as a label. The
 * chunk stays whatever the answer is. Dropping it would delete the evidence
 * that explains where an address came from.
 *
 *   POST <url>
 *   { text, provenance, source? }
 *   -> { label: "benign" | "injection" | "jailbreak", score, model }
 *
 * When the classifier cannot be reached the chunk enters unlabelled and the
 * capture records the degradation, which becomes a coverage finding. An
 * operator who thinks their classifier is running when it is not should be
 * able to see that on every verdict, not discover it in an incident.
 */
import { postJson, type HttpOptions } from "../adapters/http.js";
import {
  guardVerdictSchema,
  type GuardVerdict,
  type Provenance,
} from "../types/context.js";

export type GuardResult =
  | { readonly ok: true; readonly verdict: GuardVerdict }
  | { readonly ok: false; readonly reason: string };

export interface Guard {
  readonly name: string;
  classify(
    text: string,
    provenance: Provenance,
    source?: string,
  ): Promise<GuardResult>;
}

/** No classifier: every chunk enters unlabelled, and nothing is degraded. */
export class NoGuard implements Guard {
  readonly name = "none";

  async classify(): Promise<GuardResult> {
    return {
      ok: true,
      verdict: { label: "benign", score: 0, model: "none" },
    };
  }
}

export class HttpGuard implements Guard {
  readonly name: string;

  constructor(
    private readonly options: HttpOptions & { readonly name?: string },
  ) {
    this.name = options.name ?? "http";
  }

  async classify(
    text: string,
    provenance: Provenance,
    source?: string,
  ): Promise<GuardResult> {
    const result = await postJson(
      this.options,
      { text, provenance, ...(source === undefined ? {} : { source }) },
      guardVerdictSchema,
    );
    return result.ok
      ? { ok: true, verdict: result.value }
      : { ok: false, reason: result.reason };
  }
}
