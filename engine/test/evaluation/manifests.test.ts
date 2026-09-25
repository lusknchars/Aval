import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APPROVE,
  CLOSE_ACCOUNT,
  MANIFESTS,
  SWAP,
  TRANSFER_SOL,
  manifestFor,
  manifestVersions,
} from "../../src/evaluation/manifests/index.js";
import { manifestFindings } from "../../src/evaluation/manifest.js";
import {
  FixtureRpcClient,
  loadFixture,
  type Fixture,
} from "../../src/normalization/fixture.js";
import { normalize } from "../../src/normalization/normalize.js";
import {
  toolManifestSchema,
  validateReferences,
} from "../../src/types/manifest.js";
import type { EffectSet } from "../../src/types/effects.js";

function open(name: string): Fixture {
  const raw: unknown = JSON.parse(
    readFileSync(`test/fixtures/${name}.json`, "utf8"),
  );
  const loaded = loadFixture(raw);
  if (!loaded.ok) throw new Error(loaded.failure.message);
  return loaded.value;
}

async function effectSetOf(name: string): Promise<EffectSet> {
  const rpc = new FixtureRpcClient(open(name));
  return normalize(rpc.transaction(), rpc);
}

describe("every shipped manifest is structurally sound", () => {
  it("passes the schema and the reference validation", () => {
    // This is the CI guard. A manifest is hand-written and shared across every
    // customer, so a typo in one of them is a rule that silently matches
    // nothing, everywhere, until an incident.
    for (const manifest of MANIFESTS) {
      expect(toolManifestSchema.safeParse(manifest).success).toBe(true);
      expect({
        tool: manifest.tool,
        problems: validateReferences(manifest),
      }).toEqual({
        tool: manifest.tool,
        problems: [],
      });
    }
  });

  it("has no duplicate tool names", () => {
    const names = MANIFESTS.map((m) => m.tool);
    expect(new Set(names).size).toBe(names.length);
  });

  it("never lists the same effect as required and forbidden", () => {
    for (const manifest of MANIFESTS) {
      for (const pattern of manifest.must) {
        expect({
          tool: manifest.tool,
          type: pattern.type,
          forbidden: manifest.mustNot.includes(pattern.type),
        }).toEqual({
          tool: manifest.tool,
          type: pattern.type,
          forbidden: false,
        });
      }
    }
  });

  it("forbids giving authority away in every manifest that is not about granting it", () => {
    for (const manifest of MANIFESTS) {
      expect({
        tool: manifest.tool,
        owner: manifest.mustNot.includes("OWNER_CHANGE"),
        // A freeze moves no tokens, so no amount check in any of these would
        // ever see it. None of these primitives has any business freezing.
        freeze: manifest.mustNot.includes("ACCOUNT_FREEZE"),
      }).toEqual({
        tool: manifest.tool,
        owner: true,
        freeze: true,
      });
      const grantsDelegate = manifest.must.some(
        (p) => p.type === "DELEGATE_GRANT",
      );
      expect({
        tool: manifest.tool,
        delegate: manifest.mustNot.includes("DELEGATE_GRANT"),
      }).toEqual({
        tool: manifest.tool,
        delegate: !grantsDelegate,
      });
    }
  });

  it("looks a manifest up by tool name and admits when there is none", () => {
    expect(manifestFor("swap")).toBe(SWAP);
    expect(manifestFor("brand_new_tool")).toBeNull();
    expect(manifestVersions()).toHaveLength(MANIFESTS.length);
  });
});

describe("against real recorded transactions", () => {
  it("explains an ordinary SOL transfer with nothing left over", async () => {
    const effects = await effectSetOf("transfer-sol");
    const [from = "", to = ""] = open("transfer-sol").before.addresses;
    const findings = manifestFindings({
      effects,
      manifest: TRANSFER_SOL,
      toolCall: { name: "transfer_sol", args: { from, to, amount: 1_000_000 } },
    });
    // A legitimate call has to produce nothing. Anything here would fire on
    // every transfer the customer makes.
    expect(findings).toEqual([]);
  });

  it("catches the unlimited delegate when the tool was a swap", async () => {
    const effects = await effectSetOf("unlimited-approve");
    const [from = ""] = open("unlimited-approve").before.addresses;
    const findings = manifestFindings({
      effects,
      manifest: SWAP,
      toolCall: {
        name: "swap",
        args: { from, to: "SolAcc", mint: "SOL", amountIn: 1 },
      },
    });
    const forbidden = findings.find((f) => f.rule === "mustNot.DELEGATE_GRANT");
    expect(forbidden?.severity).toBe("critical");
  });

  it("accepts the same delegate when the tool was an approve", async () => {
    const effects = await effectSetOf("unlimited-approve");
    const [account = "", , delegate = ""] =
      open("unlimited-approve").before.addresses;
    const findings = manifestFindings({
      effects,
      manifest: APPROVE,
      toolCall: {
        name: "approve",
        args: {
          account,
          delegate,
          mint: "So11111111111111111111111111111111111111112",
          amount: "18446744073709.551615",
        },
      },
      decimals: new Map([["So11111111111111111111111111111111111111112", 6]]),
    });
    // The grant itself is expected. Nothing about it is undeclared.
    expect(findings.filter((f) => f.rule.startsWith("mustNot."))).toEqual([]);
    expect(findings.filter((f) => f.check === "magnitude")).toEqual([]);
  });

  it("explains closing an account, and still forbids giving it away", async () => {
    const effects = await effectSetOf("close-account");
    const [destination = "", account = ""] =
      open("close-account").before.addresses;
    const findings = manifestFindings({
      effects,
      manifest: CLOSE_ACCOUNT,
      toolCall: { name: "close_account", args: { account, destination } },
    });
    expect(findings.filter((f) => f.check === "undeclared")).toEqual([]);
    expect(CLOSE_ACCOUNT.mustNot).toContain("OWNER_CHANGE");
  });
});
