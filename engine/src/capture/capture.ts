/**
 * The capture layer: stamping every piece of content at the door.
 *
 * This is the part everything else rests on, and its single rule is that the
 * AGENT NEVER GETS TO SAY WHERE SOMETHING CAME FROM. The model does not pass
 * a provenance field, cannot set one, and is not asked. Whoever calls a tool
 * on the agent's behalf -- this file -- knows whether the bytes came from the
 * human or from a web page, and stamps them accordingly.
 *
 * The reason is not tidiness. Provenance is the detector that catches prompt
 * injection, and a compromised agent asked to label its own inputs labels the
 * attacker's address `user`, which is the most trusted tier there is. Self-
 * reported provenance is not a weaker version of this: it is none of it.
 *
 * The other rule is that nothing is ever dropped. A poisoned chunk stays, with
 * its stamp, because it is the evidence that explains where an address came
 * from. Editing the record to make the answer nicer is how an audit trail
 * stops being one.
 */
import type { VersionedTransaction } from "@solana/web3.js";
import { evaluate, type PolicyIdentity } from "../evaluation/verdict.js";
import { manifestFor, manifestVersions } from "../evaluation/manifests/index.js";
import type { ProvenanceConfig } from "../evaluation/provenance.js";
import { normalize } from "../normalization/normalize.js";
import type { RpcClient } from "../normalization/rpc.js";
import type { ActionContext, ContextChunk } from "../types/context.js";
import type { EffectSet } from "../types/effects.js";
import { DEFAULT_THRESHOLDS, type Thresholds, type Verdict } from "../types/verdict.js";

export interface CaptureOptions {
  readonly agentId: string;
  readonly provenance: ProvenanceConfig;
  readonly decimals: ReadonlyMap<string, number>;
  readonly thresholds?: Thresholds;
}

export interface Intercepted {
  readonly effects: EffectSet;
  readonly verdict: Verdict;
  readonly context: ActionContext;
}

export class Capture {
  readonly #chunks: ContextChunk[] = [];
  readonly #options: CaptureOptions;
  #goal = "";

  constructor(options: CaptureOptions) {
    this.#options = options;
  }

  /** What the human typed. The only thing stamped `user`. */
  fromUser(text: string): void {
    this.#goal = text;
    this.#chunks.push({ text, provenance: "user" });
  }

  /**
   * What came back from a tool the agent called.
   *
   * `source` is recorded by the caller, which knows the URL it fetched. The
   * model is never consulted about it, and could not be trusted if it were.
   */
  fromToolOutput(text: string, source?: string): void {
    this.#chunks.push({
      text,
      provenance: "tool_output",
      ...(source === undefined ? {} : { source }),
    });
  }

  /** What the agent recalled from its own memory of earlier sessions. */
  fromMemory(text: string): void {
    this.#chunks.push({ text, provenance: "memory" });
  }

  get chunks(): readonly ContextChunk[] {
    return this.#chunks;
  }

  /**
   * The moment a wallet would be asked to sign.
   *
   * Everything needed to judge exists exactly here and nowhere earlier: the
   * goal, the stamped context, the tool call the model chose, and the bytes
   * that follow from it. This is the interception point in a real integration
   * too -- wrap the wallet's signing function, and the agent cannot route
   * around it without removing the wallet.
   *
   * It reads and simulates. It never signs and never sends.
   */
  async intercept(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    tx: VersionedTransaction,
    rpc: RpcClient,
  ): Promise<Intercepted> {
    const context: ActionContext = {
      actionId: `${this.#options.agentId}-${Date.now()}`,
      agentId: this.#options.agentId,
      userGoal: this.#goal,
      systemPrompt: "",
      contextChunks: [...this.#chunks],
      toolCall: { name: tool, args },
      unsignedTx: tx,
      timestamp: Date.now(),
    };

    const effects = await normalize(tx, rpc);
    const policy: PolicyIdentity = {
      manifests: manifestVersions(),
      thresholds: this.#options.thresholds ?? DEFAULT_THRESHOLDS,
      sourcePatterns: this.#options.provenance.trustedSources.map(
        (s) => s.pattern,
      ),
      allowlist: this.#options.provenance.allowlist,
    };

    const verdict = evaluate({
      effects,
      context,
      manifest: manifestFor(tool),
      decimals: this.#options.decimals,
      provenance: this.#options.provenance,
      thresholds: this.#options.thresholds ?? DEFAULT_THRESHOLDS,
      policy,
    });

    return { effects, verdict, context };
  }
}
