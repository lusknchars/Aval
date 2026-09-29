/**
 * Getting a transaction to evaluate, from wherever it came.
 *
 * A recorded fixture, a mainnet signature, or raw wire bytes. Shared by the
 * alert CLI and the demo server, because the three sources have to behave
 * identically -- a demo that resolves transactions differently from the CLI is
 * demonstrating the demo.
 *
 * A signature is fetched as base64 rather than through the SDK's decoder: a
 * version 1 transaction can be read but not re-serialized, so keeping the
 * original bytes is what makes it simulatable at all.
 */
import { readFileSync } from "node:fs";
import { VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import { FixtureRpcClient, loadFixture } from "../normalization/fixture.js";
import {
  createRpcClient,
  readRpcConfig,
  type Network,
  type RpcClient,
} from "../normalization/rpc.js";
import { rpcCall } from "./blocks.js";

/** Exactly one of the three has to be set. */
export interface SourceRequest {
  readonly fixture: string | null;
  readonly signature: string | null;
  readonly txBase64: string | null;
  readonly network: Network;
}

const transactionReplySchema = z.object({
  result: z
    .object({ transaction: z.tuple([z.string(), z.literal("base64")]) })
    .nullable()
    .optional(),
});

export interface Source {
  readonly rpc: RpcClient;
  readonly tx: VersionedTransaction;
  /** The original wire bytes, needed for a version 1 transaction. */
  readonly rawBase64: string | null;
  /** Non-null only for a recorded fixture, whose scenario names its tool. */
  readonly fixtureAddresses: readonly string[] | null;
}

/**
 * The transaction to evaluate: a recorded fixture, a mainnet signature, or
 * raw bytes.
 *
 * A signature is fetched as base64 rather than through the SDK's decoder,
 * for the same reason the samplers do it: a version 1 transaction can be read
 * but not re-serialized, so keeping the original bytes is what makes it
 * simulatable at all.
 */
export async function loadSource(args: SourceRequest): Promise<Source | string> {
  if (args.fixture !== null) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(`test/fixtures/${args.fixture}.json`, "utf8"));
    } catch (error) {
      return `could not read fixture: ${error instanceof Error ? error.message : String(error)}`;
    }
    const loaded = loadFixture(raw);
    if (!loaded.ok) return loaded.failure.message;
    const rpc = new FixtureRpcClient(loaded.value);
    return {
      rpc,
      tx: rpc.transaction(),
      rawBase64: null,
      fixtureAddresses: loaded.value.before.addresses,
    };
  }

  const config = readRpcConfig(process.env, args.network);
  if (!config.ok) return config.failure.message;
  const rpc = createRpcClient(config.value);

  let base64 = args.txBase64;
  if (base64 === null && args.signature !== null) {
    const reply = transactionReplySchema.safeParse(
      await rpcCall(config.value.rpcUrl, "getTransaction", [
        args.signature,
        { encoding: "base64", maxSupportedTransactionVersion: 1 },
      ]),
    );
    if (!reply.success) return "the RPC reply for that signature was unreadable";
    if (reply.data.result === null || reply.data.result === undefined)
      return `no transaction found for signature ${args.signature}`;
    base64 = reply.data.result.transaction[0];
  }
  if (base64 === null) return "no transaction to evaluate";

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
  } catch (error) {
    return `could not read the transaction: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { rpc, tx, rawBase64: base64, fixtureAddresses: null };
}
