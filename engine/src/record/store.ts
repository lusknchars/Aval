/**
 * Where records go, in the two shapes needed before Postgres exists.
 *
 * `MemoryRecordStore` is for tests and for a gate nobody asked to persist.
 * `FileRecordStore` is append-only JSONL, because append-only is the property
 * that matters: a record that can be rewritten is not evidence. Postgres and
 * Drizzle replace this later behind the same interface, and the gate never
 * learns about it.
 */
import { appendFile, readFile } from "node:fs/promises";
import {
  actionRecordSchema,
  type ActionRecord,
  type RecordStore,
} from "../types/record.js";

/**
 * A structure JSON can hold, without losing anything silently.
 *
 * `detail` is typed as unknown values and a bigint is the most likely thing in
 * it -- token amounts are bigint everywhere in this codebase by rule. Passing
 * one to JSON.stringify throws, and a throw here would lose the whole record
 * over a formatting problem. So a bigint becomes its decimal string, which is
 * exactly what the checks already do when they write an amount into a detail.
 *
 * Nothing is dropped except what JSON cannot express at all: a function, a
 * symbol, or `undefined`, none of which any check writes.
 */
export function serialisable(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[too deep]";
  if (typeof value === "bigint") return value.toString();
  if (value === null) return null;
  if (Array.isArray(value))
    return value.map((entry) => serialisable(entry, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (
        typeof entry === "function" ||
        typeof entry === "symbol" ||
        entry === undefined
      )
        continue;
      out[key] = serialisable(entry, depth + 1);
    }
    return out;
  }
  if (
    typeof value === "function" ||
    typeof value === "symbol" ||
    value === undefined
  )
    return null;
  return value;
}

/**
 * A detail, rebuilt field by field.
 *
 * `serialisable` returns `unknown` because it accepts `unknown`, and the only
 * honest way back to a keyed record is to copy the keys -- no cast, per the
 * rule in CLAUDE.md that `as` stays in buffer decoding.
 */
function asDetail(value: unknown): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value)) out[key] = entry;
  }
  return out;
}

function serialisableRecord(record: ActionRecord): ActionRecord {
  return {
    ...record,
    findings: record.findings.map((finding) => ({
      ...finding,
      detail: asDetail(serialisable(finding.detail)),
    })),
  };
}

/**
 * Refused loudly, on purpose.
 *
 * A record that does not validate is a bug in whoever built it, and the only
 * place that bug is cheap to find is here.
 */
function validated(record: ActionRecord): ActionRecord {
  const parsed = actionRecordSchema.safeParse(serialisableRecord(record));
  if (!parsed.success)
    throw new Error(
      `refusing to store a malformed record: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
  return parsed.data;
}

export class MemoryRecordStore implements RecordStore {
  private readonly records: ActionRecord[] = [];

  async append(record: ActionRecord): Promise<void> {
    this.records.push(validated(record));
  }

  async all(): Promise<readonly ActionRecord[]> {
    return [...this.records];
  }
}

export class FileRecordStore implements RecordStore {
  /**
   * Lines that could not be parsed, by line number.
   *
   * Not thrown: one corrupt line must not make the whole queue unreadable,
   * because an operator who cannot see the queue sees nothing at all. Not
   * swallowed either -- it is counted here and written to stderr, so it is a
   * result rather than a silence.
   */
  readonly unreadableLines: number[] = [];

  constructor(private readonly path: string) {}

  async append(record: ActionRecord): Promise<void> {
    await appendFile(this.path, `${JSON.stringify(validated(record))}\n`, "utf8");
  }

  async all(): Promise<readonly ActionRecord[]> {
    let text = "";
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      // A store nothing has written to yet is empty, not broken. Any other
      // failure is real and must surface.
      const code =
        error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return [];
      throw error;
    }

    this.unreadableLines.length = 0;
    const records: ActionRecord[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || line.trim() === "") continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        this.unreadableLines.push(i + 1);
        console.error(`record store: line ${i + 1} is not JSON`);
        continue;
      }
      const parsed = actionRecordSchema.safeParse(raw);
      if (!parsed.success) {
        this.unreadableLines.push(i + 1);
        console.error(
          `record store: line ${i + 1} is not a record: ${parsed.error.issues[0]?.message ?? ""}`,
        );
        continue;
      }
      records.push(parsed.data);
    }
    return records;
  }
}
