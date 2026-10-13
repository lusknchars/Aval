/**
 * What a human approved, and what approving actually did.
 *
 * The review queue proposes; this is where a decision lands. Two things about
 * it are deliberate and easy to get wrong.
 *
 * NOT EVERY APPROVAL IS CONFIGURATION. Trusting an address and blocking one
 * become live policy immediately -- they are lists, and the checks read lists.
 * "Write a manifest for this tool" and "add this program to the manifest's
 * allowlist" are CODE, reviewed and versioned like code. Approving those
 * records an intention and changes nothing, and the interface has to say so:
 * an operator who thinks they fixed the noise and did not will stop trusting
 * the queue entirely.
 *
 * WHAT THEY WERE SHOWN IS KEPT. Every approval stores the retrospect as it
 * stood when the button was pressed. Months later the question is never "was
 * this reasonable" but "what were they told it would do", and that is only
 * answerable if it was written down at the time.
 */
import { appendFile, readFile } from "node:fs/promises";
import { z } from "zod";
import { subjectSchema, type Subject } from "../types/record.js";

export const approvalKindSchema = z.enum([
  "trust_address",
  "block_address",
  "write_manifest",
  "review_manifest",
  "allow_program",
]);
export type ApprovalKind = z.infer<typeof approvalKindSchema>;

/**
 * The approvals that are lists, and therefore take effect at once.
 *
 * Everything else is a change to code. Keeping the distinction in one constant
 * means the interface and the policy loader can never disagree about it.
 */
export const EFFECTIVE_KINDS: ReadonlySet<ApprovalKind> = new Set([
  "trust_address",
  "block_address",
]);

export const approvalSchema = z.object({
  kind: approvalKindSchema,
  subject: subjectSchema,
  at: z.number().int().nonnegative(),
  /** Who approved. A label, not an identity system -- that comes with auth. */
  by: z.string().min(1),
  /** The retrospect as it was shown, not as it would be recomputed today. */
  shown: z.object({
    considered: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    speculative: z.boolean(),
  }),
});
export type Approval = z.infer<typeof approvalSchema>;

export interface ApprovalStore {
  append(approval: Approval): Promise<void>;
  /** Oldest first. */
  all(): Promise<readonly Approval[]>;
}

export class MemoryApprovalStore implements ApprovalStore {
  private readonly approvals: Approval[] = [];

  async append(approval: Approval): Promise<void> {
    this.approvals.push(approvalSchema.parse(approval));
  }

  async all(): Promise<readonly Approval[]> {
    return [...this.approvals];
  }
}

export class FileApprovalStore implements ApprovalStore {
  constructor(private readonly path: string) {}

  async append(approval: Approval): Promise<void> {
    await appendFile(
      this.path,
      `${JSON.stringify(approvalSchema.parse(approval))}\n`,
      "utf8",
    );
  }

  async all(): Promise<readonly Approval[]> {
    let text = "";
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return [];
      throw error;
    }
    const approvals: Approval[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        console.error("approval store: a line is not JSON");
        continue;
      }
      const parsed = approvalSchema.safeParse(raw);
      if (!parsed.success) {
        console.error("approval store: a line is not an approval");
        continue;
      }
      approvals.push(parsed.data);
    }
    return approvals;
  }
}

export interface ApprovedPolicy {
  readonly allowlist: readonly string[];
  readonly denylist: readonly string[];
  /** Approved, and waiting on a code change. Nothing about these is live. */
  readonly pending: readonly Approval[];
}

/**
 * The live lists, from the approvals.
 *
 * LAST DECISION WINS, per address. An operator who trusts an address and later
 * blocks it means the block; replaying the log in order is what makes that
 * true without anybody having to delete anything. The log stays append-only,
 * which is the property that makes it evidence.
 *
 * Note that a contradiction resolves towards the denial anyway: the deny-list
 * check is critical, and a critical finding decides on its own. This is belt
 * and braces, and both are cheap.
 */
export function approvedPolicy(
  approvals: readonly Approval[],
): ApprovedPolicy {
  const stance = new Map<string, "trust" | "block">();
  const pending: Approval[] = [];

  for (const approval of [...approvals].sort((a, b) => a.at - b.at)) {
    if (!EFFECTIVE_KINDS.has(approval.kind)) {
      pending.push(approval);
      continue;
    }
    if (approval.subject.kind !== "address") continue;
    stance.set(
      approval.subject.value,
      approval.kind === "block_address" ? "block" : "trust",
    );
  }

  const allowlist: string[] = [];
  const denylist: string[] = [];
  for (const [address, position] of stance) {
    if (position === "block") denylist.push(address);
    else allowlist.push(address);
  }

  return { allowlist, denylist, pending };
}

/** A subject's current position, for showing state next to the button. */
export function stanceOn(
  approvals: readonly Approval[],
  subject: Subject,
): ApprovalKind | null {
  let latest: Approval | null = null;
  for (const approval of approvals) {
    if (
      approval.subject.kind !== subject.kind ||
      approval.subject.value !== subject.value
    )
      continue;
    if (latest === null || approval.at >= latest.at) latest = approval;
  }
  return latest?.kind ?? null;
}
