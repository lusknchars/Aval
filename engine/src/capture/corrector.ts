/**
 * The corrector: a cleaner copy of the user's text, for the model only.
 *
 * The user's prompt has two readers with opposite needs. The model wants it
 * clean, so a typo does not turn into the wrong tool. The provenance check
 * wants it UNTOUCHED, because it is the evidence of what the human actually
 * said, and evidence is not edited. So the original is what gets stamped
 * `user`, and the corrected copy is what the model reads. If a corrector ever
 * introduced an address, it would not be in the original, and provenance
 * would still call it unexplained.
 *
 * Two rules, enforced here and not left to the corrector's good behaviour:
 *
 *  - It never touches anything shaped like an address or an amount. A
 *    "corrected" address is a guess, and a wrong guess sends the money to a
 *    stranger with a valid checksum. If the corrected text's addresses or
 *    numbers differ from the original's in any way, the correction is REFUSED
 *    and the original is used.
 *  - A malformed address is a warning, never a fix.
 *
 *   POST <url>
 *   { text }
 *   -> { text, model }
 */
import { z } from "zod";
import { postJson, type HttpOptions } from "../adapters/http.js";

export const correctionSchema = z.object({
  text: z.string(),
  model: z.string().min(1),
});
export type Correction = z.infer<typeof correctionSchema>;

export type CorrectorResult =
  | { readonly ok: true; readonly correction: Correction }
  | { readonly ok: false; readonly reason: string };

export interface Corrector {
  readonly name: string;
  correct(text: string): Promise<CorrectorResult>;
}

/** No corrector: the model reads exactly what the human typed. */
export class NoCorrector implements Corrector {
  readonly name = "none";

  async correct(text: string): Promise<CorrectorResult> {
    return { ok: true, correction: { text, model: "none" } };
  }
}

export class HttpCorrector implements Corrector {
  readonly name: string;

  constructor(
    private readonly options: HttpOptions & { readonly name?: string },
  ) {
    this.name = options.name ?? "http";
  }

  async correct(text: string): Promise<CorrectorResult> {
    const result = await postJson(this.options, { text }, correctionSchema);
    return result.ok
      ? { ok: true, correction: result.value }
      : { ok: false, reason: result.reason };
  }
}

/** Anything base58 and long enough to be a Solana address. */
const ADDRESS_LIKE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
/** Anything numeric, with or without a decimal part or thousands separators. */
const AMOUNT_LIKE = /\d[\d.,_]*/g;

function protectedTokens(text: string): readonly string[] {
  const addresses = text.match(ADDRESS_LIKE) ?? [];
  const amounts = text.match(AMOUNT_LIKE) ?? [];
  return [...addresses, ...amounts].sort((a, b) => a.localeCompare(b));
}

export type SafeCorrection =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The corrected text, only if it changed nothing that must not change.
 *
 * Compared as multisets, so an address that moved within the sentence is
 * fine and an address that changed by one character is not. Order of the
 * tokens is irrelevant; their exact spelling and count are everything.
 */
export function safeCorrection(
  original: string,
  corrected: string,
): SafeCorrection {
  const before = protectedTokens(original);
  const after = protectedTokens(corrected);
  if (before.length !== after.length)
    return {
      ok: false,
      reason: `the correction changed the number of addresses or amounts (${before.length} -> ${after.length})`,
    };
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i])
      return {
        ok: false,
        reason: `the correction changed an address or amount (${before[i] ?? ""} -> ${after[i] ?? ""})`,
      };
  }
  return { ok: true, text: corrected };
}

/**
 * Whether a token that looks like an address is one.
 *
 * A warning, never a fix. The capture surfaces this so the model -- or the
 * human -- can ask, instead of a corrector deciding what the user meant.
 */
export function malformedAddresses(text: string): readonly string[] {
  // Anything that is mostly base58 but carries a character base58 does not
  // have, or is the wrong length for an address: a paste that lost a
  // character, a 0 where an o should be.
  const candidates = text.match(/[0-9A-Za-z]{28,48}/g) ?? [];
  return candidates.filter((token) => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token));
}
