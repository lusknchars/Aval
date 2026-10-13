/**
 * The HTTP adapter, against a real local server: every way an external tool
 * can misbehave comes back as a result, and nothing throws.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { postJson } from "../../src/adapters/http.js";
import { HttpJudge } from "../../src/judge/http.js";
import { readFileSync } from "node:fs";
import { FixtureRpcClient, loadFixture } from "../../src/normalization/fixture.js";
import { normalize } from "../../src/normalization/normalize.js";
import type { EffectSet } from "../../src/types/effects.js";

/** A real EffectSet from a recorded transaction, no network. */
async function recordedEffects(): Promise<EffectSet> {
  const raw: unknown = JSON.parse(readFileSync("test/fixtures/transfer-sol.json", "utf8"));
  const loaded = loadFixture(raw);
  if (!loaded.ok) throw new Error(loaded.failure.message);
  const rpc = new FixtureRpcClient(loaded.value);
  return normalize(rpc.transaction(), rpc);
}


let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => { body += String(chunk); });
    req.on("end", () => {
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ tighten: { to: "deny", reason: "drain" }, model: "gemma" }));
      } else if (req.url === "/echo") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      } else if (req.url === "/allow") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ tighten: { to: "allow", reason: "fine" }, model: "gemma" }));
      } else if (req.url === "/garbage") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("not json {");
      } else if (req.url === "/slow") {
        setTimeout(() => { res.writeHead(200); res.end("{}"); }, 500);
      } else {
        res.writeHead(500); res.end("boom");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the adapter never throws", () => {
  it("returns the parsed value on a good answer", async () => {
    const judge = new HttpJudge({ url: `${base}/ok`, name: "gemma" });
    const result = await judge.judge({
      record: {
        actionId: "a", agentId: "x", at: 1, decision: "allow", signed: false,
        tool: "t", manifestTool: null, manifestVia: null, messageDigest: null,
        policyVersion: "p", feePayer: null, findings: [],
      },
      effects: await recordedEffects(),
      userGoal: "", toolCall: { name: "t", args: {} }, chunks: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.opinion.tighten?.to).toBe("deny");
  });

  it("refuses an answer that tries to allow, as a contract violation", async () => {
    const result = await postJson({ url: `${base}/allow` }, {}, z.object({
      tighten: z.object({ to: z.enum(["flag", "deny"]), reason: z.string() }).nullable(),
      model: z.string(),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/does not match the contract/);
  });

  it("serialises a bigint as its decimal string", async () => {
    const result = await postJson({ url: `${base}/echo` }, { amount: 123n }, z.object({ amount: z.string() }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.amount).toBe("123");
  });

  it("reports a non-JSON body", async () => {
    const result = await postJson({ url: `${base}/garbage` }, {}, z.object({}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("response is not JSON");
  });

  it("reports an HTTP error", async () => {
    const result = await postJson({ url: `${base}/nope` }, {}, z.object({}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("HTTP 500");
  });

  it("times out instead of hanging the gate", async () => {
    const result = await postJson({ url: `${base}/slow`, timeoutMs: 50 }, {}, z.object({}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("timed out");
  });

  it("reports an unreachable host", async () => {
    const result = await postJson({ url: "http://127.0.0.1:1", timeoutMs: 2000 }, {}, z.object({}));
    expect(result.ok).toBe(false);
  });
});
