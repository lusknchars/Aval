/**
 * The gate, tested on the only question that matters about it: can anything
 * get signed that the verdict did not approve?
 *
 * Every test here uses a recorded mainnet transaction and no network. Nothing
 * is signed for real: the "wallet" returns a string, because what is being
 * tested is whether it is REACHED, not what it produces.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { declarationFor, toDecimalArgs } from "../../src/cli/declaration.js";
import { Gate, GateRefusal, guardedSigner } from "../../src/gate/gate.js";
import { Authorizer } from "../../src/gate/authorization.js";
import { MemoryRecordStore } from "../../src/record/store.js";
import {
  FixtureRpcClient,
  loadFixture,
  type Fixture,
} from "../../src/normalization/fixture.js";
import { messageBytes } from "../../src/normalization/message.js";
import { normalize } from "../../src/normalization/normalize.js";
import { counterparties } from "../../src/types/effects.js";
import type { ActionContext } from "../../src/types/context.js";
import type { VersionedTransaction } from "@solana/web3.js";

function open(name: string): Fixture {
  const raw: unknown = JSON.parse(
    readFileSync(`test/fixtures/${name}.json`, "utf8"),
  );
  const loaded = loadFixture(raw);
  if (!loaded.ok) throw new Error(loaded.failure.message);
  return loaded.value;
}

/**
 * The context a TRUTHFUL agent would have produced for a recorded transaction:
 * the tool call read off the transaction's own effects, and a goal that names
 * every counterparty. Anything that is not allowed from here is a false
 * positive, so it is the right baseline for testing the gate rather than the
 * checks.
 */
async function honestContext(
  name: string,
  overrides: Partial<ActionContext> = {},
): Promise<{
  readonly context: ActionContext;
  readonly rpc: FixtureRpcClient;
}> {
  const rpc = new FixtureRpcClient(open(name));
  const tx = rpc.transaction();
  const set = await normalize(tx, rpc);
  const declaration = declarationFor(set);
  if (declaration === null) throw new Error(`no primitive matched ${name}`);
  const named = counterparties(set).join(", ");
  const goal = `send funds to ${named === "" ? "myself" : named}`;
  return {
    rpc,
    context: {
      actionId: `gate-${name}`,
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
      ...overrides,
    },
  };
}

function wallet(): (tx: VersionedTransaction) => Promise<string> {
  return async () => "signed";
}

describe("the decision is what decides", () => {
  it("signs an allowed transaction, and hands the signer a ticket", async () => {
    const { context, rpc } = await honestContext("transfer-sol");
    const authorizer = new Authorizer();
    const gate = new Gate({ rpc, authorizer });

    let seenDigest: string | null = null;
    const outcome = await gate.sign(context, async (_tx, authorization) => {
      seenDigest = authorization.messageDigest;
      return "signed";
    });

    expect(outcome.verdict.decision).toBe("allow");
    expect(outcome.signed).toBe(true);
    expect(seenDigest).toBe(outcome.verdict.messageDigest);
  });

  it("refuses to sign a denied transaction, and the signer is never called", async () => {
    // A goal that names nobody: the destination came from somewhere AVAL
    // cannot see, which is the whole detection.
    const { context, rpc } = await honestContext("transfer-sol", {
      userGoal: "do the thing we discussed",
      contextChunks: [
        { text: "do the thing we discussed", provenance: "user" },
      ],
    });
    const gate = new Gate({ rpc, authorizer: new Authorizer() });

    let called = false;
    await expect(
      gate.sign(context, async () => {
        called = true;
        return "signed";
      }),
    ).rejects.toThrow(GateRefusal);
    expect(called).toBe(false);
  });

  it("carries the verdict on the refusal, so an agent can say why", async () => {
    const { context, rpc } = await honestContext("transfer-sol", {
      userGoal: "do the thing we discussed",
      contextChunks: [
        { text: "do the thing we discussed", provenance: "user" },
      ],
    });
    const gate = new Gate({ rpc, authorizer: new Authorizer() });
    const error: unknown = await gate
      .sign(context, wallet())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GateRefusal);
    if (error instanceof GateRefusal) {
      expect(error.decision).toBe("deny");
      expect(error.verdict.findings.length).toBeGreaterThan(0);
    }
  });

  it("reviews without ever being able to sign", async () => {
    const { context, rpc } = await honestContext("transfer-sol");
    const verdict = await new Gate({
      rpc,
      authorizer: new Authorizer(),
    }).review(context);
    expect(verdict.decision).toBe("allow");
  });
});

describe("what a FLAG does is policy, and it is recorded either way", () => {
  /**
   * An honest transaction called through a tool nobody wrote a manifest for.
   *
   * That is the ordinary FLAG, and by far the most common one on real traffic:
   * the effects are fine and the checks that would have judged them never ran.
   */
  async function flagged(): Promise<{
    readonly context: ActionContext;
    readonly rpc: FixtureRpcClient;
  }> {
    return honestContext("transfer-sol", {
      toolCall: { name: "SolanaLendTool", args: {} },
    });
  }

  it("signs a flag by default, and keeps the record", async () => {
    const { context, rpc } = await flagged();
    const store = new MemoryRecordStore();
    const gate = new Gate({ rpc, authorizer: new Authorizer(), store });
    const outcome = await gate.sign(context, wallet());

    expect(outcome.verdict.decision).not.toBe("allow");
    expect(outcome.signed).toBe(true);
    const [record] = await store.all();
    expect(record?.signed).toBe(true);
    // The tool the agent named is kept as the agent spelled it, and the
    // absence of a manifest is a fact about the record, not a gap in it.
    expect(record?.tool).toBe("SolanaLendTool");
    expect(record?.manifestTool).toBeNull();
  });

  it("holds a flag when the operator asked for that, and still records", async () => {
    const { context, rpc } = await flagged();
    const store = new MemoryRecordStore();
    const gate = new Gate({
      rpc,
      authorizer: new Authorizer(),
      store,
      onFlag: "hold",
    });
    await expect(gate.sign(context, wallet())).rejects.toThrow(/holding it/);
    const [record] = await store.all();
    expect(record?.signed).toBe(false);
    expect(record?.decision).toBe("flag");
  });

  it("records a denial too, because a denial is the evidence", async () => {
    const { context, rpc } = await honestContext("transfer-sol", {
      userGoal: "do the thing we discussed",
      contextChunks: [
        { text: "do the thing we discussed", provenance: "user" },
      ],
    });
    const store = new MemoryRecordStore();
    const gate = new Gate({ rpc, authorizer: new Authorizer(), store });
    await expect(gate.sign(context, wallet())).rejects.toThrow(GateRefusal);
    const [record] = await store.all();
    expect(record?.decision).toBe("deny");
    expect(record?.signed).toBe(false);
    expect(record?.findings.length).toBeGreaterThan(0);
  });
});

describe("the authorisation is about bytes, not about a claim", () => {
  it("refuses a different transaction presented with a valid ticket", async () => {
    // The substitution: AVAL approves one transaction, and the agent presents
    // another to the wallet. This is the case the whole mechanism exists for.
    const approved = await honestContext("transfer-sol");
    const other = new FixtureRpcClient(open("close-account")).transaction();

    const authorizer = new Authorizer();
    const gate = new Gate({ rpc: approved.rpc, authorizer });
    const signer = guardedSigner(wallet(), authorizer, (tx) =>
      messageBytes(tx, undefined),
    );

    await expect(
      gate.sign(approved.context, async (_tx, authorization) =>
        signer(other, authorization),
      ),
    ).rejects.toThrow(/not the ones that were approved/);
  });

  it("signs when the bytes are the ones that were approved", async () => {
    const { context, rpc } = await honestContext("transfer-sol");
    const authorizer = new Authorizer();
    const gate = new Gate({ rpc, authorizer });
    const signer = guardedSigner(wallet(), authorizer, (tx) =>
      messageBytes(tx, undefined),
    );
    const outcome = await gate.sign(context, signer);
    expect(outcome.result).toBe("signed");
  });

  it("refuses the same ticket a second time", async () => {
    // On a blockchain, signing the approved transaction twice is a second
    // transfer, not a duplicate.
    const { context, rpc } = await honestContext("transfer-sol");
    const authorizer = new Authorizer();
    const gate = new Gate({ rpc, authorizer });
    const signer = guardedSigner(wallet(), authorizer, (tx) =>
      messageBytes(tx, undefined),
    );

    let kept: Parameters<typeof signer>[1] | null = null;
    await gate.sign(context, async (tx, authorization) => {
      kept = authorization;
      return signer(tx, authorization);
    });
    expect(kept).not.toBeNull();
    if (kept !== null)
      await expect(signer(context.unsignedTx, kept)).rejects.toThrow(
        /already been used/,
      );
  });
});
