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
 *
 * Three external tools sit at this door, each behind an interface with a
 * no-op default, so the pipeline runs whole before any of them exists:
 *
 *   - the CORRECTOR gives the model a cleaner copy of the user's text; the
 *     ORIGINAL is what gets stamped, and a correction that touches an address
 *     or an amount is refused;
 *   - the GUARD labels every chunk as it enters; the chunk stays either way;
 *   - the OCR turns an image into a chunk marked `via: "ocr"`.
 *
 * When any of them fails, the failure is written into `degradations` and
 * becomes a coverage finding on the verdict. A layer the operator believes is
 * running is visibly running, or visibly not.
 */
import type { VersionedTransaction } from "@solana/web3.js";
import { evaluate, type PolicyIdentity } from "../evaluation/verdict.js";
import { lookupManifest, manifestVersions } from "../evaluation/manifests/index.js";
import type { ProvenanceConfig } from "../evaluation/provenance.js";
import { normalize } from "../normalization/normalize.js";
import type { RpcClient } from "../normalization/rpc.js";
import type {
  ActionContext,
  ContextChunk,
  Provenance,
} from "../types/context.js";
import type { EffectSet } from "../types/effects.js";
import { DEFAULT_THRESHOLDS, type Thresholds, type Verdict } from "../types/verdict.js";
import { malformedAddresses, NoCorrector, safeCorrection, type Corrector } from "./corrector.js";
import { NoGuard, type Guard } from "./guard.js";
import type { Ocr } from "./ocr.js";

export interface CaptureOptions {
  readonly agentId: string;
  readonly provenance: ProvenanceConfig;
  readonly decimals: ReadonlyMap<string, number>;
  readonly thresholds?: Thresholds;
  readonly guard?: Guard;
  readonly corrector?: Corrector;
  readonly ocr?: Ocr;
}

export interface Intercepted {
  readonly effects: EffectSet;
  readonly verdict: Verdict;
  readonly context: ActionContext;
}

export class Capture {
  readonly #chunks: ContextChunk[] = [];
  readonly #degradations: string[] = [];
  readonly #options: CaptureOptions;
  readonly #guard: Guard;
  readonly #corrector: Corrector;
  #goal = "";

  constructor(options: CaptureOptions) {
    this.#options = options;
    this.#guard = options.guard ?? new NoGuard();
    this.#corrector = options.corrector ?? new NoCorrector();
  }

  /**
   * What the human typed. The only thing stamped `user`.
   *
   * Returns what the MODEL should read: the corrected copy when there is one
   * and it changed nothing that must not change, the original otherwise. The
   * original is what is stamped and what provenance will check against,
   * whatever the model was shown.
   */
  async fromUser(text: string): Promise<string> {
    this.#goal = text;
    await this.#push({ text, provenance: "user" });

    const malformed = malformedAddresses(text);
    if (malformed.length > 0)
      this.#degradations.push(
        `the prompt carries ${malformed.length} token(s) shaped like a broken address; not corrected`,
      );

    const result = await this.#corrector.correct(text);
    if (!result.ok) {
      this.#degradations.push(`corrector ${this.#corrector.name}: ${result.reason}`);
      return text;
    }
    if (result.correction.text === text) return text;

    const safe = safeCorrection(text, result.correction.text);
    if (!safe.ok) {
      this.#degradations.push(
        `corrector ${this.#corrector.name} refused: ${safe.reason}`,
      );
      return text;
    }
    return safe.text;
  }

  /**
   * What came back from a tool the agent called.
   *
   * `source` is recorded by the caller, which knows the URL it fetched. The
   * model is never consulted about it, and could not be trusted if it were.
   */
  async fromToolOutput(text: string, source?: string): Promise<void> {
    await this.#push({
      text,
      provenance: "tool_output",
      ...(source === undefined ? {} : { source }),
    });
  }

  /** What the agent recalled from its own memory of earlier sessions. */
  async fromMemory(text: string): Promise<void> {
    await this.#push({ text, provenance: "memory" });
  }

  /**
   * An image the agent was shown, read through the OCR.
   *
   * The text enters with the provenance of wherever the image came from and
   * `via: "ocr"`. Without an OCR configured, or when it fails, nothing enters
   * and the capture says so: the model reads less, which is the safe side.
   */
  async fromImage(
    image: Uint8Array,
    mimeType: string,
    provenance: Exclude<Provenance, "user" | "system">,
    source?: string,
  ): Promise<string | null> {
    const ocr = this.#options.ocr;
    if (ocr === undefined) {
      this.#degradations.push("an image was shown to the agent and no OCR is configured");
      return null;
    }
    const result = await ocr.read(image, mimeType);
    if (!result.ok) {
      this.#degradations.push(`ocr ${ocr.name}: ${result.reason}`);
      return null;
    }
    await this.#push({
      text: result.reading.text,
      provenance,
      via: "ocr",
      ...(source === undefined ? {} : { source }),
    });
    return result.reading.text;
  }

  /** Stamp, label, keep. Every chunk goes through here. */
  async #push(chunk: ContextChunk): Promise<void> {
    const labelled = await this.#guard.classify(
      chunk.text,
      chunk.provenance,
      chunk.source,
    );
    if (!labelled.ok) {
      this.#degradations.push(`guard ${this.#guard.name}: ${labelled.reason}`);
      this.#chunks.push(chunk);
      return;
    }
    // A no-op guard answers benign with no model behind it. Writing that on
    // the chunk would claim a classification that never happened.
    this.#chunks.push(
      labelled.verdict.model === "none"
        ? chunk
        : { ...chunk, guard: labelled.verdict },
    );
  }

  get chunks(): readonly ContextChunk[] {
    return this.#chunks;
  }

  get degradations(): readonly string[] {
    return this.#degradations;
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
      ...(this.#degradations.length === 0
        ? {}
        : { degradations: [...this.#degradations] }),
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
      manifest: lookupManifest(tool, args)?.manifest ?? null,
      decimals: this.#options.decimals,
      provenance: this.#options.provenance,
      thresholds: this.#options.thresholds ?? DEFAULT_THRESHOLDS,
      policy,
    });

    return { effects, verdict, context };
  }
}
