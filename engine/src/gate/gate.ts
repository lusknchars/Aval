/**
 * The gate: the point where a verdict stops being an opinion.
 *
 * Everything before this file computes an answer. This file is what makes the
 * answer binding, and it does so by one structural move: THE AGENT NO LONGER
 * HOLDS A SIGNING FUNCTION. It holds this. An agent that wants to sign around
 * the gate has to remove the wallet, which is a different and much louder
 * problem than a check nobody wired up.
 *
 * Three decisions, and only one of them is a judgement call:
 *
 *   ALLOW -> mint a single-use authorisation over the digest, then sign.
 *   DENY  -> throw. Nothing is signed.
 *   FLAG  -> configurable, defaulting to SIGN AND RECORD.
 *
 * That default is deliberate and it is the only one that is a choice. A FLAG
 * that holds every ambiguous call makes the product unusable: on real mainnet
 * traffic most FLAGs are "no manifest exists for this tool", not "somebody is
 * stealing". So a FLAG signs, and it leaves a record behind -- which is what
 * the review queue reads, and what turns repetition into a proposal a human
 * approves. `onFlag: "hold"` exists for operators who want the stricter
 * posture, and it is a policy decision, not a safety one.
 *
 * What this costs, stated plainly: once FLAG signs, DENY is the only decision
 * that blocks, so the accuracy of DENY is the accuracy of the product.
 */
import type { VersionedTransaction } from "@solana/web3.js";
import { lookupManifest } from "../evaluation/manifests/index.js";
import { evaluate } from "../evaluation/verdict.js";
import { normalize } from "../normalization/normalize.js";
import type { RpcClient } from "../normalization/rpc.js";
import { buildActionRecord } from "../record/build.js";
import type { ActionContext } from "../types/context.js";
import type { ProvenanceConfig } from "../evaluation/provenance.js";
import type { PolicyIdentity } from "../evaluation/verdict.js";
import type { RecordStore } from "../types/record.js";
import type { Decision, Thresholds, Verdict } from "../types/verdict.js";
import { Authorizer, type Authorization } from "./authorization.js";

/** What a FLAG does. The only configurable decision. */
export type FlagPolicy = "sign" | "hold" | "refuse";

/**
 * Whoever actually holds the key.
 *
 * It takes the authorisation because it is expected to verify it. A signer that
 * ignores the second argument is a signer with no gate, and that is visible in
 * its type rather than buried in a convention.
 */
export type Signer<T> = (
  tx: VersionedTransaction,
  authorization: Authorization,
) => Promise<T>;

export interface GateOptions {
  readonly rpc: RpcClient;
  readonly authorizer: Authorizer;
  /** Absent means nothing is kept, which also means no review queue. */
  readonly store?: RecordStore;
  readonly onFlag?: FlagPolicy;
  readonly provenance?: ProvenanceConfig;
  readonly policy?: PolicyIdentity;
  readonly thresholds?: Thresholds;
  readonly decimals?: ReadonlyMap<string, number>;
  /** Base64 of the whole transaction, when the caller already has it. */
  readonly rawTransactionBase64?: string;
}

/**
 * Why nothing was signed.
 *
 * It carries the verdict, because an agent that is refused has to be able to
 * tell its user what happened, and a bare "refused" is what gets a gate
 * disabled in week two.
 */
export class GateRefusal extends Error {
  readonly verdict: Verdict;
  readonly decision: Decision;

  constructor(message: string, verdict: Verdict) {
    super(message);
    this.name = "GateRefusal";
    this.verdict = verdict;
    this.decision = verdict.decision;
  }
}

export interface GateOutcome<T> {
  readonly verdict: Verdict;
  readonly signed: true;
  readonly result: T;
}

export class Gate {
  constructor(private readonly options: GateOptions) {}

  /**
   * Evaluate and record, without signing anything.
   *
   * Separate from `sign` because the two answer different questions: this one
   * is "what would happen", and it is what the demo, the CLIs and any dry run
   * need. Nothing here can sign even by mistake -- it never sees a signer.
   */
  async review(context: ActionContext): Promise<Verdict> {
    const { verdict } = await this.evaluateAndRecord(context, false);
    return verdict;
  }

  /**
   * The enforcement point.
   *
   * Resolves, simulates, evaluates, records, and only then -- and only on a
   * decision that permits it -- mints an authorisation and calls the signer.
   */
  async sign<T>(
    context: ActionContext,
    signer: Signer<T>,
  ): Promise<GateOutcome<T>> {
    const { verdict, permitted, reason } = await this.evaluateAndRecord(
      context,
      true,
    );

    if (!permitted) throw new GateRefusal(reason, verdict);

    // An ALLOW with no digest is not an ALLOW anything can act on: there is
    // nothing to bind the authorisation to, so there is no way for the signer
    // to know it is signing what was approved. Degrade, never open.
    if (verdict.messageDigest === null)
      throw new GateRefusal(
        "the transaction's bytes could not be read, so nothing can be authorised",
        verdict,
      );

    const authorization = this.options.authorizer.issue(
      verdict.actionId,
      verdict.messageDigest,
    );
    const result = await signer(context.unsignedTx, authorization);
    return { verdict, signed: true, result };
  }

  private async evaluateAndRecord(
    context: ActionContext,
    forSigning: boolean,
  ): Promise<{
    readonly verdict: Verdict;
    readonly permitted: boolean;
    readonly reason: string;
  }> {
    const found = lookupManifest(context.toolCall.name, context.toolCall.args);

    const effects = await normalize(context.unsignedTx, this.options.rpc, {
      ...(this.options.rawTransactionBase64 === undefined
        ? {}
        : { rawTransactionBase64: this.options.rawTransactionBase64 }),
    });

    const verdict = evaluate({
      effects,
      context,
      manifest: found?.manifest ?? null,
      ...(this.options.decimals === undefined
        ? {}
        : { decimals: this.options.decimals }),
      ...(this.options.provenance === undefined
        ? {}
        : { provenance: this.options.provenance }),
      ...(this.options.policy === undefined
        ? {}
        : { policy: this.options.policy }),
      ...(this.options.thresholds === undefined
        ? {}
        : { thresholds: this.options.thresholds }),
    });

    const onFlag = this.options.onFlag ?? "sign";
    const { permitted, reason } = permission(verdict.decision, onFlag);

    // Recorded before signing, and recorded whether or not it signs. A record
    // written after the signature is a record that a crash removes exactly
    // when it matters most.
    if (this.options.store !== undefined) {
      await this.options.store.append(
        buildActionRecord({
          verdict,
          context,
          manifestTool: found?.manifest.tool ?? null,
          manifestVia: found?.via ?? null,
          feePayer: effects.feePayer,
          signed: forSigning && permitted,
        }),
      );
    }

    return { verdict, permitted, reason };
  }
}

function permission(
  decision: Decision,
  onFlag: FlagPolicy,
): { readonly permitted: boolean; readonly reason: string } {
  if (decision === "allow") return { permitted: true, reason: "" };
  if (decision === "deny")
    return {
      permitted: false,
      reason: "VETO denied this transaction; nothing was signed",
    };
  if (onFlag === "sign") return { permitted: true, reason: "" };
  if (onFlag === "hold")
    return {
      permitted: false,
      reason: "VETO flagged this transaction and is holding it for review",
    };
  return {
    permitted: false,
    reason: "VETO flagged this transaction and this operator refuses flags",
  };
}

/**
 * A signing function with the authorisation enforced, for a signer that does
 * not enforce it itself.
 *
 * This is where the mechanism becomes real. `raw` is the wallet's own signing
 * function and knows nothing about VETO; the wrapper recomputes the digest of
 * the bytes in front of it and refuses anything that does not match the ticket.
 * Put the wrapper as close to the key as the integration allows: every layer
 * between it and the key is a layer that could substitute bytes.
 */
export function guardedSigner<T>(
  raw: (tx: VersionedTransaction) => Promise<T>,
  authorizer: Authorizer,
  messageBytesOf: (tx: VersionedTransaction) => Uint8Array | null,
): Signer<T> {
  return async (tx, authorization) => {
    const bytes = messageBytesOf(tx);
    if (bytes === null)
      throw new Error(
        "refusing to sign: the message bytes could not be read, so the authorisation cannot be checked",
      );
    const check = authorizer.consume(authorization, bytes);
    if (!check.ok) throw new Error(`refusing to sign: ${check.reason}`);
    return raw(tx);
  };
}
