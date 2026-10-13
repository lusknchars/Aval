/**
 * One way to call an external tool over HTTP, shared by every adapter.
 *
 * The judge, the input classifier, the OCR and the corrector are all built
 * outside this repository and reached the same way: POST JSON, read JSON,
 * validate it against a schema, and turn everything that can go wrong into a
 * RESULT rather than a throw. An adapter that throws on a timeout takes the
 * whole gate down with it, and a gate that is down is a gate somebody
 * disables.
 *
 * bigint is serialised as its decimal string, for the same reason the record
 * store does it: token amounts are bigint everywhere here by rule, and
 * JSON.stringify would throw on the first one.
 */
import type { z } from "zod";
import { serialisable } from "../record/store.js";

export type HttpResult<T> =
  | { readonly ok: true; readonly value: T; readonly latencyMs: number }
  | { readonly ok: false; readonly reason: string; readonly latencyMs: number };

export interface HttpOptions {
  readonly url: string;
  /** Sent as a bearer token when present. Never logged. */
  readonly token?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export async function postJson<T>(
  options: HttpOptions,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<HttpResult<T>> {
  const started = Date.now();
  const elapsed = (): number => Date.now() - started;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.token === undefined
          ? {}
          : { authorization: `Bearer ${options.token}` }),
      },
      body: JSON.stringify(serialisable(body)),
      signal: controller.signal,
    });
    if (!response.ok)
      return {
        ok: false,
        reason: `HTTP ${response.status}`,
        latencyMs: elapsed(),
      };

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return { ok: false, reason: "response is not JSON", latencyMs: elapsed() };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success)
      return {
        ok: false,
        reason: `response does not match the contract: ${parsed.error.issues[0]?.message ?? ""}`,
        latencyMs: elapsed(),
      };
    return { ok: true, value: parsed.data, latencyMs: elapsed() };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError"
        ? "timed out"
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, reason, latencyMs: elapsed() };
  } finally {
    clearTimeout(timer);
  }
}
