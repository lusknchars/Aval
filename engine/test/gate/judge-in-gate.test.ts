/**
 * The judge inside the gate: consulted after the deterministic verdict,
 * before the signature, and unable to open anything.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { declarationFor, toDecimalArgs } from "../../src/cli/declaration.js";
import { Gate, GateRefusal } from "../../src/gate/gate.js";
import { Authorizer } from "../../src/gate/authorization.js";
import { MemoryRecordStore } from "../../src/record/store.js";
import {
  FixtureRpcClient,
  loadFixture,
  type Fixture,
} from "../../src/normalization/fixture.js";
import { normalize } from "../../src/normalization/normalize.js";
import { counterparties } from "../../src/types/effects.js";
import type { ActionContext } from "../../src/types/context.js";
import type { Judge, JudgeInput } from "../../src/types/judge.js";

function open(name: string): Fixture {
  const raw: unknown = JSON.parse(readFileSync(`test/fixtures/${name}.json`, "utf8"));
  const loaded = loadFixture(raw);
  if (!loaded.ok) throw new Error(loaded.failure.message);
  return loaded.value;
}

async function honest(silent = false): Promise<{ context: ActionContext; rpc: FixtureRpcClient }> {
  const rpc = new FixtureRpcClient(open("transfer-sol"));
  const tx = rpc.transaction();
  const set = await normalize(tx, rpc);
  const declaration = declarationFor(set);
  if (declaration === null) throw new Error("no primitive");
  const goal = silent ? "do the thing" : `send funds to ${counterparties(set).join(", ")}`;
  return {
    rpc,
    context: {
      actionId: "j", agentId: "t", userGoal: goal, systemPrompt: "",
      contextChunks: [{ text: goal, provenance: "user" }],
      toolCall: { name: declaration.tool, args: toDecimalArgs(declaration, new Map()) },
      unsignedTx: tx, timestamp: Date.now(),
    },
  };
}

function judgeThat(to: "flag" | "deny" | null, seen: JudgeInput[] = []): Judge {
  return {
    name: "fake-judge",
    judge: async (input) => {
      seen.push(input);
      return {
        ok: true,
        opinion: { tighten: to === null ? null : { to, reason: "test" }, model: "fake" },
        latencyMs: 1,
      };
    },
  };
}

describe("the judge in the gate", () => {
  it("receives our effects and the deterministic verdict, and can deny", async () => {
    const { context, rpc } = await honest();
    const seen: JudgeInput[] = [];
    const store = new MemoryRecordStore();
    const gate = new Gate({ rpc, authorizer: new Authorizer(), store, judge: judgeThat("deny", seen) });

    await expect(gate.sign(context, async () => "signed")).rejects.toThrow(GateRefusal);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.record.decision).toBe("allow");
    expect(seen[0]?.effects.effects.length).toBeGreaterThan(0);
    const [record] = await store.all();
    expect(record?.decision).toBe("deny");
    expect(record?.findings.map((f) => f.rule)).toContain("judge.deny");
  });

  it("is not consulted when the deterministic verdict is already deny", async () => {
    const { context, rpc } = await honest(true);
    const seen: JudgeInput[] = [];
    const gate = new Gate({ rpc, authorizer: new Authorizer(), judge: judgeThat(null, seen) });
    await expect(gate.sign(context, async () => "signed")).rejects.toThrow(GateRefusal);
    expect(seen).toEqual([]);
  });

  it("signs when the judge has nothing to add", async () => {
    const { context, rpc } = await honest();
    const gate = new Gate({ rpc, authorizer: new Authorizer(), judge: judgeThat(null) });
    const outcome = await gate.sign(context, async () => "signed");
    expect(outcome.signed).toBe(true);
    expect(outcome.verdict.decision).toBe("allow");
  });

  it("records the judge as unavailable and signs on the deterministic allow", async () => {
    const { context, rpc } = await honest();
    const down: Judge = {
      name: "gemma",
      judge: async () => ({ ok: false, reason: "timed out", latencyMs: 5000 }),
    };
    const store = new MemoryRecordStore();
    const gate = new Gate({ rpc, authorizer: new Authorizer(), store, judge: down });
    const outcome = await gate.sign(context, async () => "signed");
    expect(outcome.signed).toBe(true);
    const [record] = await store.all();
    expect(record?.findings.map((f) => f.rule)).toContain("coverage.judge_unavailable");
  });
});
