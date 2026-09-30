/**
 * The external tools, from configuration.
 *
 * This is the whole integration surface for the layers built outside this
 * repository. Each one is a URL; absent means the no-op default, and the
 * pipeline runs whole either way. Plugging Gemma, Prompt Guard, the OCR or
 * the corrector in is setting the variable and restarting.
 *
 *   VETO_JUDGE_URL       the customer's model, may only tighten
 *   VETO_GUARD_URL       the input classifier, labels and never drops
 *   VETO_OCR_URL         image to text, stamped `via: "ocr"`
 *   VETO_CORRECTOR_URL   a cleaner copy for the model; the original is stamped
 *   VETO_ADAPTER_TOKEN   bearer token sent to all of them, when set
 *   VETO_ADAPTER_TIMEOUT_MS   default 5000
 *
 * Nothing here is logged. A URL can carry a key, and a token is a token.
 */
import { HttpCorrector, type Corrector } from "../capture/corrector.js";
import { HttpGuard, type Guard } from "../capture/guard.js";
import { HttpOcr, type Ocr } from "../capture/ocr.js";
import { HttpJudge } from "../judge/http.js";
import type { Judge } from "../types/judge.js";
import type { HttpOptions } from "./http.js";

export interface Adapters {
  readonly judge: Judge | undefined;
  readonly guard: Guard | undefined;
  readonly ocr: Ocr | undefined;
  readonly corrector: Corrector | undefined;
  /** Which are configured, by name, for a startup line that names no URL. */
  readonly configured: readonly string[];
}

type Env = Readonly<Record<string, string | undefined>>;

function url(env: Env, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value.trim() === "") return undefined;
  try {
    new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  return value;
}

export function adaptersFromEnv(env: Env): Adapters {
  const token = env["VETO_ADAPTER_TOKEN"];
  const timeoutRaw = env["VETO_ADAPTER_TIMEOUT_MS"];
  const timeoutMs =
    timeoutRaw === undefined || timeoutRaw === "" ? undefined : Number(timeoutRaw);
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0))
    throw new Error("VETO_ADAPTER_TIMEOUT_MS must be a positive integer");

  const shared = (target: string): HttpOptions => ({
    url: target,
    ...(token === undefined || token === "" ? {} : { token }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

  const judgeUrl = url(env, "VETO_JUDGE_URL");
  const guardUrl = url(env, "VETO_GUARD_URL");
  const ocrUrl = url(env, "VETO_OCR_URL");
  const correctorUrl = url(env, "VETO_CORRECTOR_URL");

  const configured: string[] = [];
  if (judgeUrl !== undefined) configured.push("judge");
  if (guardUrl !== undefined) configured.push("guard");
  if (ocrUrl !== undefined) configured.push("ocr");
  if (correctorUrl !== undefined) configured.push("corrector");

  return {
    judge:
      judgeUrl === undefined
        ? undefined
        : new HttpJudge({ ...shared(judgeUrl), name: "judge" }),
    guard:
      guardUrl === undefined
        ? undefined
        : new HttpGuard({ ...shared(guardUrl), name: "guard" }),
    ocr:
      ocrUrl === undefined
        ? undefined
        : new HttpOcr({ ...shared(ocrUrl), name: "ocr" }),
    corrector:
      correctorUrl === undefined
        ? undefined
        : new HttpCorrector({ ...shared(correctorUrl), name: "corrector" }),
    configured,
  };
}
