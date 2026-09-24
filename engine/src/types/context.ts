/**
 * Context captured inside the client's agent runtime.
 *
 * `provenance` is the single most important field in the system: without it,
 * VETO's highest-value detector does not exist. An address that appears only
 * in a `retrieved` chunk is the fingerprint of indirect prompt injection.
 *
 * Everything here is UNTRUSTED INPUT. It comes from the client's process, not
 * from VETO, which is why every type has a Zod schema: if `provenance` arrives
 * malformed, the provenance check degrades silently -- the worst possible
 * failure mode for this project.
 *
 * Origin is NEVER declared by the agent. It is assigned by VETO's
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

/** A piece of context that entered the model, with its origin assigned. */
export const contextChunkSchema = z.object({
  text: z.string(),
  provenance: provenanceSchema,
  /** url, document id or memory key. Matched against SourceTrust.pattern. */
  source: z.string().optional(),
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
 * Everything VETO receives about one action, before evaluating it.
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
});
export type ActionContext = z.infer<typeof actionContextSchema>;

/**
 * Trust level of a source, defaulting to `untrusted` for anything not
 * configured. First matching pattern wins, so list order matters.
 *
 * KNOWN LIMITATION: matching is by substring. An attacker controlling
 * "https://malicious.xyz/?ref=quote-api.jup.ag" would be treated as `trusted`
 * if that pattern is configured. Harden to hostname comparison (with domain
 * suffix) when the provenance detector is built -- until then, customer
 * configuration must use specific patterns.
 */
export function sourceTrustLevel(
  source: string | undefined,
  configured: readonly SourceTrust[],
): TrustLevel {
  if (source === undefined) return "untrusted";
  const matched = configured.find((c) => source.includes(c.pattern));
  return matched?.level ?? "untrusted";
}

/**
 * Whether a chunk can be used to explain where an address came from.
 *
 * `user` and `system` are trusted by construction. The other three only count
 * when the source was explicitly marked `trusted` by the customer.
 */
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
