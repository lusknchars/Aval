/**
 * Context captured inside the client's agent runtime.
 *
 * `provenance` is the single most important field in the system: without it,
 * AVAL's highest-value detector does not exist. An address that appears only
 * in a `retrieved` chunk is the fingerprint of indirect prompt injection.
 *
 * Everything here is UNTRUSTED INPUT. It comes from the client's process, not
 * from AVAL, which is why every type has a Zod schema: if `provenance` arrives
 * malformed, the provenance check degrades silently -- the worst possible
 * failure mode for this project.
 *
 * Origin is NEVER declared by the agent. It is assigned by AVAL's
 * instrumentation at the moment each piece of content enters the runtime. The
 * agent is not a trusted source about its own decision.
 */
import { VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";

/** Where a piece of context came from. Closed. */
export const provenanceSchema = z.enum([
  "user", // typed by the human
  "system", // system prompt, under the operator's control
  "retrieved", // RAG, web page, fetched document
  "memory", // the agent's persisted memory
  "tool_output", // return value of a tool
]);
export type Provenance = z.infer<typeof provenanceSchema>;

/**
 * Per-source trust level, configured by the customer at onboarding.
 *
 * It exists to contain the system's largest source of false positives: not all
 * retrieved content is hostile. An agent calling a DEX routing API receives
 * legitimate addresses that were never in the user's goal. Treating every
 * `tool_output` as hostile would make the customer turn the alert off.
 *
 * An unconfigured source defaults to `untrusted` -- degrade, never open.
 */
export const trustLevelSchema = z.enum(["trusted", "semi", "untrusted"]);
export type TrustLevel = z.infer<typeof trustLevelSchema>;

export const sourceTrustSchema = z.object({
  /** Domain, tool name or memory key. */
  pattern: z.string().min(1),
  level: trustLevelSchema,
});
export type SourceTrust = z.infer<typeof sourceTrustSchema>;

/**
 * What an input classifier said about a chunk. Check E reads this.
 *
 * It is a LABEL, and the chunk stays. A classifier that drops what it flags
 * destroys the record that explains where an address came from, and a dropped
 * chunk can never be shown to the person who has to decide. The classifier is
 * external -- Prompt Guard today, anything tomorrow -- and this is the whole
 * of what AVAL asks of it: a label, a confidence and a name.
 */
export const guardLabelSchema = z.enum(["benign", "injection", "jailbreak"]);
export type GuardLabel = z.infer<typeof guardLabelSchema>;

export const guardVerdictSchema = z.object({
  label: guardLabelSchema,
  /** The classifier's confidence in the label, 0..1. */
  score: z.number().min(0).max(1),
  /** Model and version, so a label is attributable months later. */
  model: z.string().min(1),
});
export type GuardVerdict = z.infer<typeof guardVerdictSchema>;

/**
 * A piece of context that entered the model, with its origin assigned.
 *
 * `provenance` says WHERE it came from. `via` says HOW it was read, and only
 * exists for the case where that changes what the text is worth: a chunk that
 * came out of OCR is an interpretation of an image, not a copy of it.
 */
export const contextChunkSchema = z.object({
  text: z.string(),
  provenance: provenanceSchema,
  /** url, document id or memory key. Matched against SourceTrust.pattern. */
  source: z.string().optional(),
  via: z.enum(["ocr"]).optional(),
  guard: guardVerdictSchema.optional(),
});
export type ContextChunk = z.infer<typeof contextChunkSchema>;

/** The tool call emitted by the agent: level 2, already structured. */
export const toolCallSchema = z.object({
  name: z.string().min(1),
  /** Values the manifest's `arg:` placeholders resolve against. */
  args: z.record(z.string(), z.unknown()),
});
export type ToolCall = z.infer<typeof toolCallSchema>;

/**
 * Everything AVAL receives about one action, before evaluating it.
 *
 * The transaction arrives already deserialized. The SDK boundary (wire format,
 * base64) belongs to the capture layer, not to this contract.
 */
export const actionContextSchema = z.object({
  actionId: z.string().min(1),
  agentId: z.string().min(1),
  taskId: z.string().min(1).optional(),

  /** What the human asked for. Level 1, ambiguous by nature. */
  userGoal: z.string(),
  systemPrompt: z.string(),

  /** Everything that entered the model's context, each piece with its origin. */
  contextChunks: z.array(contextChunkSchema),
  toolCall: toolCallSchema,

  unsignedTx: z.instanceof(VersionedTransaction),
  /** Milliseconds since the epoch. */
  timestamp: z.number().int().nonnegative(),
  /**
   * What the capture could not do: a classifier that timed out, an OCR that
   * failed, a correction that was refused. Each becomes a coverage finding,
   * so a layer the operator believes is running is visibly running -- or
   * visibly not -- on every verdict.
   */
  degradations: z.array(z.string()).optional(),
});
export type ActionContext = z.infer<typeof actionContextSchema>;

/**
 * Whether a configured pattern matches a source.
 *
 * Substring matching used to be the rule here, and it was the single most
 * dangerous line in the system: a customer who configured `jup` would be
 * trusting `evil-jup-clone.xyz`, and would have no way of knowing. Worse, the
 * failure is silent -- an over-broad pattern does not raise an error, it just
 * quietly stops the provenance check from ever firing.
 *
 * Two shapes are allowed, and nothing else:
 *
 *   - a hostname, matched on label boundaries, so `jup.ag` covers
 *     `quote-api.jup.ag` and never `jup.ag.attacker.com`;
 *   - an exact identifier for a tool name or memory key, matched whole.
 */
export function sourceMatches(source: string, pattern: string): boolean {
  if (pattern.includes(".")) {
    const host = hostnameOf(source);
    if (host === null) return false;
    return host === pattern || host.endsWith(`.${pattern}`);
  }
  return source === pattern;
}

function hostnameOf(source: string): string | null {
  try {
    return new URL(source).hostname.toLowerCase();
  } catch {
    // Not a URL: a bare hostname is still usable, anything else is not.
    return /^[a-z0-9.-]+$/i.test(source) ? source.toLowerCase() : null;
  }
}

/**
 * Trust level of a source, defaulting to `untrusted` for anything not
 * configured. First matching pattern wins, so list order matters.
 */
export function sourceTrustLevel(
  source: string | undefined,
  configured: readonly SourceTrust[],
): TrustLevel {
  if (source === undefined) return "untrusted";
  const matched = configured.find((c) => sourceMatches(source, c.pattern));
  return matched?.level ?? "untrusted";
}

export interface ConfigProblem {
  readonly pattern: string;
  readonly reason: string;
}

/**
 * Rejects configuration that would silently disable the provenance check.
 *
 * This runs at onboarding, not at decision time. A customer mistake here is
 * the only kind that switches off a whole detector without producing a single
 * alert, so it has to fail loudly when it is written, not quietly forever
 * after.
 */
export function validateSourceTrust(
  configured: readonly SourceTrust[],
): readonly ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  for (const entry of configured) {
    const pattern = entry.pattern.trim();
    if (pattern !== entry.pattern) {
      problems.push({
        pattern: entry.pattern,
        reason: "has leading or trailing whitespace",
      });
    }
    if (pattern.length < 3) {
      problems.push({ pattern, reason: "too short to identify a source" });
      continue;
    }
    if (pattern.includes("://") || pattern.includes("/")) {
      problems.push({
        pattern,
        reason: "use a hostname, not a URL: paths and schemes are not matched",
      });
      continue;
    }
    if (!pattern.includes(".")) {
      // Allowed, but only as an exact identifier, and worth saying out loud.
      if (!/^[A-Za-z0-9_:-]+$/.test(pattern)) {
        problems.push({
          pattern,
          reason: "not a hostname and not a valid identifier",
        });
      }
      continue;
    }
    const labels = pattern.split(".");
    if (labels.length < 2 || labels.some((label) => label === "")) {
      problems.push({ pattern, reason: "not a valid hostname" });
      continue;
    }
    const tld = labels[labels.length - 1] ?? "";
    if (tld.length < 2) {
      problems.push({
        pattern,
        reason: "hostname has no usable top-level domain",
      });
    }
    if (labels.length === 1) {
      problems.push({
        pattern,
        reason: "a bare label would trust every domain under it",
      });
    }
  }
  return problems;
}

export function chunkIsTrusted(
  chunk: ContextChunk,
  configured: readonly SourceTrust[],
): boolean {
  switch (chunk.provenance) {
    case "user":
    case "system":
      return true;
    case "retrieved":
    case "memory":
    case "tool_output":
      return sourceTrustLevel(chunk.source, configured) === "trusted";
  }
}
