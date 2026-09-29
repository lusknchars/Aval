/**
 * The record: what is kept after a decision, and what a reviewer reads.
 *
 * FLAG allows the transaction. That is a deliberate choice -- a FLAG that
 * holds every ambiguous call makes the product unusable, and on real mainnet
 * traffic most FLAGs are "we have no manifest for this tool", not "somebody is
 * stealing". So a FLAG has to leave something behind, or it is a detection
 * that changed nothing.
 *
 * Two rules shaped this file.
 *
 * ONLY STRUCTURED FACTS. The record holds verdicts, findings, tools, effects
 * and addresses. It never holds the untrusted prose a chunk came from. A
 * reviewer who approves while reading attacker-written text is being phished,
 * and a corpus of attacker prose is a corpus that reads back as instructions.
 *
 * REPETITION IS EVIDENCE, NOT A DECISION. Nothing in here promotes itself.
 * A subject seen fifty times is fifty rows and a count; turning that into a
 * deny is a policy change, and policy changes are made by a human approving a
 * diff. Frequency correlates with routine far more than with attack, and a
 * counter that denies on its own can be driven by whoever can make the counter
 * go up.
 */
import { z } from "zod";
import { toolMatchSchema, type ToolMatch } from "./manifest.js";
import {
  checkKindSchema,
  decisionSchema,
  severitySchema,
  type CheckKind,
  type Decision,
  type Severity,
} from "./verdict.js";

/**
 * The three kinds of thing an approval can be about.
 *
 * There are three because there are three outcomes: an address goes on an
 * allowlist or a deny-list, a tool gets a manifest, a program gets added to a
 * manifest's allowlist. A fourth kind with no possible outcome would be a
 * button that does nothing.
 */
export type SubjectKind = "address" | "tool" | "program";

export interface Subject {
  readonly kind: SubjectKind;
  readonly value: string;
}

/**
 * A finding as stored: the same rule and severity, plus the subjects it is
 * about, resolved once at write time.
 *
 * Resolving at write time and not at read time is deliberate: it means the
 * queue a reviewer sees months from now groups the way the rules grouped when
 * they fired, and not the way today's extractor happens to group.
 */
export interface RecordedFinding {
  readonly check: CheckKind;
  readonly severity: Severity;
  readonly rule: string;
  readonly subjects: readonly Subject[];
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface ActionRecord {
  readonly actionId: string;
  readonly agentId: string;
  /** Milliseconds since the epoch. */
  readonly at: number;
  readonly decision: Decision;
  /** Whether the signature actually happened, which is not the same thing. */
  readonly signed: boolean;
  /** The tool as the AGENT spelled it. */
  readonly tool: string;
  /** The manifest it resolved to, and how. null when none matched. */
  readonly manifestTool: string | null;
  readonly manifestVia: ToolMatch | null;
  /** sha256 of the signable message, hex. The only thing tying this to bytes. */
  readonly messageDigest: string | null;
  readonly policyVersion: string;
  readonly feePayer: string | null;
  readonly findings: readonly RecordedFinding[];
}

/**
 * Where records go.
 *
 * An interface rather than a table because CLAUDE.md puts Postgres and Drizzle
 * in a later phase, and the gate must not have to change when it arrives. The
 * only operations anything needs are "append one" and "read them all back".
 */
export interface RecordStore {
  append(record: ActionRecord): Promise<void>;
  /** Oldest first. */
  all(): Promise<readonly ActionRecord[]>;
}

/**
 * The schema, used at both ends for different reasons.
 *
 * On write it is a bug detector: a record that does not validate is refused
 * loudly, where the bug is, instead of being persisted and discovered by
 * whoever reads the queue months later. On read it is a parser, because a line
 * on disk is data and data is never trusted just for being ours.
 */
export const subjectSchema = z.object({
  kind: z.enum(["address", "tool", "program"]),
  value: z.string().min(1),
});

export const recordedFindingSchema = z.object({
  check: checkKindSchema,
  severity: severitySchema,
  rule: z.string().min(1),
  subjects: z.array(subjectSchema),
  detail: z.record(z.string(), z.unknown()),
});

export const actionRecordSchema = z.object({
  actionId: z.string().min(1),
  agentId: z.string(),
  at: z.number().int().nonnegative(),
  decision: decisionSchema,
  signed: z.boolean(),
  tool: z.string(),
  manifestTool: z.string().nullable(),
  manifestVia: toolMatchSchema.nullable(),
  messageDigest: z.string().nullable(),
  policyVersion: z.string(),
  feePayer: z.string().nullable(),
  findings: z.array(recordedFindingSchema),
});
