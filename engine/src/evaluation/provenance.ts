/**
 * Where did this address come from?
 *
 * The question nothing else asks, and the only one that catches the most
 * common attack. Consider an agent that reads a poisoned page and emits
 * `transfer({ to: "7xKX…", amount: 500 })`. The manifest check passes
 * perfectly: the transaction does exactly what the tool call said. The
 * corruption is not in the execution, it is in the ORIGIN of the argument.
 *
 * The implementation is a string search. The value is not in the algorithm,
 * it is in having the labels at all -- which is why capture stamps every
 * chunk at the door, and the agent never gets to say where something came
 * from.
 */
import { counterparties, type EffectSet } from "../types/effects.js";
import {
  chunkIsTrusted,
  type ActionContext,
  type ContextChunk,
  type SourceTrust,
} from "../types/context.js";
import type { Finding, Severity } from "../types/verdict.js";

/**
 * How an address came to be in this transaction, worst case first.
 *
 * `unexplained` is worse than it sounds: an address that appears in no chunk
 * at all was produced somewhere VETO does not observe. Absence is a signal,
 * not silence.
 */
export type Origin =
  | "own_account" // the agent receiving its own funds back
  | "user_goal" // the human named it
  | "allowlist" // the customer approved it in advance
  | "trusted_source" // came from a source the customer marked trusted
  | "known_counterparty" // this agent has dealt with it before
  | "untrusted_source" // appears only in retrieved, memory or untrusted tool output
  | "unexplained"; // appears nowhere

const SEVERITY_BY_ORIGIN: Readonly<Record<Origin, Severity | null>> = {
  own_account: null,
  user_goal: null,
  allowlist: null,
  trusted_source: "low",
  known_counterparty: "medium",
  untrusted_source: "critical",
  unexplained: "critical",
};

export interface ProvenanceConfig {
  readonly trustedSources: readonly SourceTrust[];
  /** Addresses the customer approved in advance. */
  readonly allowlist: readonly string[];
  /** Addresses this agent has transacted with before. Empty until history exists. */
  readonly knownCounterparties: readonly string[];
  /**
   * The agent's own addresses: its wallet, and any account it controls.
   *
   * Value arriving at one of these is the agent receiving its own funds --
   * the output side of a swap, change coming back, a token account it owns.
   * Treating that as a counterparty would raise a critical finding on every
   * legitimate swap, since the agent's own derived accounts appear in no
   * prompt and on no page.
   */
  readonly ownAccounts: readonly string[];
}

export const EMPTY_PROVENANCE_CONFIG: ProvenanceConfig = {
  trustedSources: [],
  allowlist: [],
  knownCounterparties: [],
  ownAccounts: [],
};

/**
 * How much of an address has to be present for a head-only truncation to
 * count. Eight base58 characters is about 47 bits: enough that the match is
 * the address, not a collision.
 */
const PREFIX_ONLY_LENGTH = 8;

/**
 * Whether an address appears in a piece of text.
 *
 * Exact match first, then truncated forms: interfaces and logs routinely show
 * `7xKX…9fPq` rather than the full 44 characters, and a check that only looked
 * for the full string would miss the address precisely where a human would
 * have seen it. The ellipsis is required, so a four-character coincidence does
 * not count as a match.
 *
 * KNOWN LIMITATION: an address assembled by concatenation, or encoded, is not
 * found. There is no complete answer to that; the content classifier covers
 * part of it, because the surrounding text usually still reads as an
 * instruction.
 */
export function addressAppearsIn(text: string, address: string): boolean {
  if (text.includes(address)) return true;
  if (address.length < 12) return false;

  // Walk forward from each place the address starts, see how much of it
  // actually continues, and then decide. A regex cannot do this cleanly
  // because the truncation point varies: wallets cut at four characters,
  // logs at ten, people at wherever they stopped copying.
  const head = address.slice(0, 4);
  const tail = address.slice(-4);
  for (let from = 0; ;) {
    const at = text.indexOf(head, from);
    if (at === -1) return false;
    from = at + 1;

    let matched = 0;
    while (matched < address.length && text[at + matched] === address[matched])
      matched++;

    const rest = text.slice(at + matched);
    const cut = /^(?:\.{2,3}|…|\*{2,})(.*)$/.exec(rest);
    if (cut === null) continue;

    // Enough of the head to identify the address on its own.
    if (matched >= PREFIX_ONLY_LENGTH) return true;
    // Or the shorter form wallets display, where the tail follows the cut.
    if (cut[1]?.startsWith(tail) === true) return true;
  }
}

/** Every chunk the address shows up in, by index, so the finding can name them. */
function chunksMentioning(
  address: string,
  chunks: readonly ContextChunk[],
): number[] {
  const found: number[] = [];
  chunks.forEach((chunk, index) => {
    if (addressAppearsIn(chunk.text, address)) found.push(index);
  });
  return found;
}

export interface ProvenanceVerdict {
  readonly address: string;
  readonly origin: Origin;
  /** Indexes into contextChunks, so an alert can quote the actual source. */
  readonly foundInChunks: readonly number[];
  readonly sources: readonly string[];
}

/**
 * Classifies one address against the captured context.
 *
 * Order matters and is deliberate: an address the human named is legitimate
 * even if it also appears in a web page, and an allowlisted address is
 * legitimate even if it appears nowhere at all.
 */
export function classifyAddress(
  address: string,
  context: ActionContext,
  config: ProvenanceConfig,
): ProvenanceVerdict {
  const chunkIndexes = chunksMentioning(address, context.contextChunks);
  const sources = chunkIndexes
    .map((i) => context.contextChunks[i]?.source)
    .filter((source): source is string => source !== undefined);

  // Money coming back to the agent is not money leaving.
  if (config.ownAccounts.includes(address)) {
    return {
      address,
      origin: "own_account",
      foundInChunks: chunkIndexes,
      sources,
    };
  }
  if (addressAppearsIn(context.userGoal, address)) {
    return {
      address,
      origin: "user_goal",
      foundInChunks: chunkIndexes,
      sources,
    };
  }
  if (config.allowlist.includes(address)) {
    return {
      address,
      origin: "allowlist",
      foundInChunks: chunkIndexes,
      sources,
    };
  }

  const trustedChunk = chunkIndexes.some((i) => {
    const chunk = context.contextChunks[i];
    return chunk !== undefined && chunkIsTrusted(chunk, config.trustedSources);
  });
  if (trustedChunk) {
    return {
      address,
      origin: "trusted_source",
      foundInChunks: chunkIndexes,
      sources,
    };
  }

  if (config.knownCounterparties.includes(address)) {
    return {
      address,
      origin: "known_counterparty",
      foundInChunks: chunkIndexes,
      sources,
    };
  }

  // Appearing only in untrusted context is the fingerprint of indirect prompt
  // injection. Appearing nowhere is worse: it was produced somewhere VETO
  // does not observe at all.
  return {
    address,
    origin: chunkIndexes.length > 0 ? "untrusted_source" : "unexplained",
    foundInChunks: chunkIndexes,
    sources,
  };
}

/**
 * Checks every address that receives value or authority.
 *
 * Only counterparties, on purpose. An address the transaction merely reads
 * from is not where the money goes.
 */
export function provenanceFindings(
  set: EffectSet,
  context: ActionContext,
  config: ProvenanceConfig = EMPTY_PROVENANCE_CONFIG,
): readonly Finding[] {
  const findings: Finding[] = [];

  for (const address of counterparties(set)) {
    const verdict = classifyAddress(address, context, config);
    const severity = SEVERITY_BY_ORIGIN[verdict.origin];
    if (severity === null) continue;

    findings.push({
      check: "provenance",
      severity,
      rule: `provenance.${verdict.origin}`,
      detail: {
        counterparty: address,
        origin: verdict.origin,
        foundInChunks: verdict.foundInChunks,
        sources: verdict.sources,
        provenances: verdict.foundInChunks.map(
          (i) => context.contextChunks[i]?.provenance ?? "unknown",
        ),
      },
    });
  }

  return findings;
}
