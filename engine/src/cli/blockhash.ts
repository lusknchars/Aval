/** Isolated so the recorder keeps no direct dependency on Connection. */
import { Connection } from "@solana/web3.js";
import type { RpcConfig } from "../normalization/rpc.js";

export async function recentBlockhash(config: RpcConfig): Promise<string> {
  const connection = new Connection(config.rpcUrl, { commitment: config.commitment });
  return (await connection.getLatestBlockhash(config.commitment)).blockhash;
}
