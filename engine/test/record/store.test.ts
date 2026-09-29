import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FileRecordStore,
  MemoryRecordStore,
  serialisable,
} from "../../src/record/store.js";
import type { ActionRecord } from "../../src/types/record.js";

function record(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return {
    actionId: "a1",
    agentId: "agent",
    at: 1_700_000_000_000,
    decision: "flag",
    signed: true,
    tool: "SolanaTransferTool",
    manifestTool: "transfer_token",
    manifestVia: "by_argument",
    messageDigest: "ab12",
    policyVersion: "p1",
    feePayer: "Payer",
    findings: [
      {
        check: "provenance",
        severity: "high",
        rule: "provenance.unexplained",
        subjects: [{ kind: "address", value: "9xQeWv" }],
        detail: { counterparty: "9xQeWv" },
      },
    ],
    ...overrides,
  };
}

describe("a bigint never costs us the record", () => {
  it("writes an amount as its decimal string instead of throwing", () => {
    expect(serialisable({ amount: 12345678901234567890n })).toEqual({
      amount: "12345678901234567890",
    });
  });

  it("stores a finding whose detail carries a bigint", async () => {
    const store = new MemoryRecordStore();
    await store.append(
      record({
        findings: [
          {
            check: "magnitude",
            severity: "high",
            rule: "magnitude.above_declared",
            subjects: [{ kind: "tool", value: "transfer_token" }],
            detail: { declared: 400n, observed: 600n },
          },
        ],
      }),
    );
    const [stored] = await store.all();
    expect(stored?.findings[0]?.detail).toEqual({
      declared: "400",
      observed: "600",
    });
  });

  it("does not recurse for ever on a self-referencing detail", () => {
    const loop: Record<string, unknown> = {};
    loop["self"] = loop;
    expect(() => serialisable(loop)).not.toThrow();
  });
});

describe("a malformed record is refused where the bug is", () => {
  it("throws on append rather than persisting nonsense", async () => {
    const store = new MemoryRecordStore();
    await expect(
      // An empty actionId: a record nothing can ever be traced back to.
      store.append(record({ actionId: "" })),
    ).rejects.toThrow(/malformed record/);
    expect(await store.all()).toEqual([]);
  });
});

describe("the file store is append-only and survives a bad line", () => {
  it("reads back what it wrote, oldest first", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "veto-")), "records.jsonl");
    const store = new FileRecordStore(path);
    await store.append(record({ actionId: "first", at: 1 }));
    await store.append(record({ actionId: "second", at: 2 }));
    expect((await store.all()).map((r) => r.actionId)).toEqual([
      "first",
      "second",
    ]);
  });

  it("treats a store nobody has written to as empty, not broken", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "veto-")), "absent.jsonl");
    expect(await new FileRecordStore(path).all()).toEqual([]);
  });

  it("keeps the queue readable when one line is corrupt, and says so", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "veto-")), "records.jsonl");
    const store = new FileRecordStore(path);
    await store.append(record({ actionId: "good" }));
    writeFileSync(path, "{ not json\n", { flag: "a" });
    await store.append(record({ actionId: "alsoGood" }));

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const all = await store.all();
    errors.mockRestore();

    expect(all.map((r) => r.actionId)).toEqual(["good", "alsoGood"]);
    expect(store.unreadableLines).toEqual([2]);
  });
});
