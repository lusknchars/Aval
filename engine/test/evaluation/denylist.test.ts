/**
 * The deny-list: the one place where accumulated observation changes a
 * decision, and only because a person put the entry there.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { denylistFindings } from "../../src/evaluation/denylist.js";
import { evaluate } from "../../src/evaluation/verdict.js";
import { manifestFor } from "../../src/evaluation/manifests/index.js";
import {
  FixtureRpcClient,
  loadFixture,
  type Fixture,
} from "../../src/normalization/fixture.js";
import { normalize } from "../../src/normalization/normalize.js";
import { counterparties, type EffectSet } from "../../src/types/effects.js";
import { declarationFor, toDecimalArgs } from "../../src/cli/declaration.js";
import type { ActionContext } from "../../src/types/context.js";

function open(name: string): Fixture {
  const raw: unknown = JSON.parse(
    readFileSync(`test/fixtures/${name}.json`, "utf8"),
  );
  const loaded = loadFixture(raw);
  if (!loaded.ok) throw new Error(loaded.failure.message);
  return loaded.value;
}

async function honest(name: string): Promise<{
  readonly set: EffectSet;
  readonly context: ActionContext;
}> {
  const rpc = new FixtureRpcClient(open(name));
  const tx = rpc.transaction();
  const set = await normalize(tx, rpc);
  const declaration = declarationFor(set);
  if (declaration === null) throw new Error(`no primitive matched ${name}`);
  const goal = `send funds to ${counterparties(set).join(", ")}`;
  return {
    set,
    context: {
      actionId: "denylist",
      agentId: "test",
      userGoal: goal,
      systemPrompt: "",
      contextChunks: [{ text: goal, provenance: "user" }],
      toolCall: {
        name: declaration.tool,
        args: toDecimalArgs(declaration, new Map()),
      },
      unsignedTx: tx,
      timestamp: Date.now(),
    },
  };
}

describe("an address a human blocked", () => {
  it("does nothing when the list is empty", async () => {
    const { set } = await honest("transfer-sol");
    expect(denylistFindings(set, [])).toEqual([]);
  });

  it("turns an otherwise allowed transaction into a denial", async () => {
    const { set, context } = await honest("transfer-sol");
    const clean = evaluate({
      effects: set,
      context,
      manifest: manifestFor(context.toolCall.name),
    });
    expect(clean.decision).toBe("allow");

    const target = counterparties(set)[0];
    expect(target).toBeDefined();
    const blocked = evaluate({
      effects: set,
      context,
      manifest: manifestFor(context.toolCall.name),
      provenance: {
        trustedSources: [],
        allowlist: [],
        knownCounterparties: [],
        ownAccounts: [],
        denylist: target === undefined ? [] : [target],
      },
    });
    expect(blocked.decision).toBe("deny");
    expect(blocked.findings.map((f) => f.rule)).toContain("denylist.address");
  });

  it("wins over an allowlist entry for the same address", async () => {
    // Two operator statements that contradict each other resolve towards the
    // denial. Degrade, never open.
    const { set, context } = await honest("transfer-sol");
    const target = counterparties(set)[0] ?? "";
    const verdict = evaluate({
      effects: set,
      context,
      manifest: manifestFor(context.toolCall.name),
      provenance: {
        trustedSources: [],
        allowlist: [target],
        knownCounterparties: [],
        ownAccounts: [],
        denylist: [target],
      },
    });
    expect(verdict.decision).toBe("deny");
  });

  it("reports one finding per address, listing every role it played", async () => {
    const { set } = await honest("transfer-sol");
    const payer = set.feePayer ?? "";
    const findings = denylistFindings(set, [payer]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail["roles"]).toContain("fee payer");
    // Named `counterparty` so the review queue groups it with the same address.
    expect(findings[0]?.detail["counterparty"]).toBe(payer);
  });

  it("ignores an address the transaction never touches", async () => {
    const { set } = await honest("transfer-sol");
    expect(denylistFindings(set, ["SomeAddressNotHere"])).toEqual([]);
  });
});
