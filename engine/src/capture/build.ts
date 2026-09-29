/**
 * Turning a tool call into the transaction a wallet would be asked to sign.
 *
 * This is the customer's code in real life -- their agent builds the
 * transaction from its own arguments -- and it is reproduced here so the whole
 * chain is genuine: a prompt a human typed, a tool call a model chose, and the
 * bytes that follow from it. Nothing about the result is fabricated.
 *
 * NOTHING IS SIGNED AND NOTHING IS SENT. The message is compiled with a fee
 * payer that only has to exist, because the simulation runs with
 * `sigVerify: false`, and no private key is created, loaded or stored anywhere
 * in this file.
 */
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  AuthorityType,
  createApproveInstruction,
  createBurnInstruction,
  createCloseAccountInstruction,
  createFreezeAccountInstruction,
  createRevokeInstruction,
  createSetAuthorityInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ComputeBudgetProgram } from "@solana/web3.js";

export interface BuildFailure {
  readonly ok: false;
  readonly reason: string;
}
export type BuildResult =
  | { readonly ok: true; readonly tx: VersionedTransaction }
  | BuildFailure;

function key(value: unknown, field: string): PublicKey | string {
  if (typeof value !== "string") return `${field} is missing`;
  try {
    return new PublicKey(value);
  } catch {
    return `${field} is not a valid address`;
  }
}

/**
 * Decimal to raw units.
 *
 * A model writes "1.5"; the chain counts in the smallest unit. Getting this
 * wrong by a factor of a billion is the most ordinary way an agent destroys a
 * wallet without anybody lying.
 */
function raw(value: unknown, decimals: number): bigint | string {
  const text =
    typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  if (!/^\d+(\.\d+)?$/.test(text)) return "amount is not a number";
  const [whole = "0", fraction = ""] = text.split(".");
  if (fraction.length > decimals) return "amount has more precision than the mint";
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

/**
 * Authority names as a model would say them, mapped to the program's enum.
 *
 * `owner` is `AccountOwner`, which is the one that takes the account away
 * entirely -- worth spelling out, because it is the least obvious name for the
 * most severe operation here.
 */
const AUTHORITY_TYPES: Readonly<Record<string, AuthorityType>> = {
  owner: AuthorityType.AccountOwner,
  close: AuthorityType.CloseAccount,
  mint: AuthorityType.MintTokens,
  freeze: AuthorityType.FreezeAccount,
};

function compile(
  payer: PublicKey,
  blockhash: string,
  instructions: TransactionInstruction[],
  priorityFee: unknown,
): VersionedTransaction {
  // A priority fee is an arbitrary amount of SOL leaving the wallet that no
  // manifest bounds, so the agent has to be able to set one -- otherwise the
  // ceiling check has never been exercised by anything but a unit test.
  const withBudget =
    typeof priorityFee === "number" && priorityFee > 0
      ? [
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: Math.trunc(priorityFee),
          }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          ...instructions,
        ]
      : instructions;
  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions: withBudget,
    }).compileToV0Message(),
  );
}

export interface BuildInput {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly wallet: PublicKey;
  readonly blockhash: string;
  /** Decimals per mint, so a decimal amount can be converted. */
  readonly decimals: ReadonlyMap<string, number>;
}

export function buildTransaction(input: BuildInput): BuildResult {
  const { args, wallet, blockhash } = input;
  const fail = (reason: string): BuildFailure => ({ ok: false, reason });

  switch (input.tool) {
    case "transfer_sol": {
      const to = key(args["to"], "to");
      if (typeof to === "string") return fail(to);
      const lamports = args["amount"];
      if (typeof lamports !== "number" || !Number.isFinite(lamports))
        return fail("amount is not a number of lamports");
      return {
        ok: true,
        tx: compile(wallet, blockhash, [
          SystemProgram.transfer({
            fromPubkey: wallet,
            toPubkey: to,
            lamports: BigInt(Math.trunc(lamports)),
          }),
        ], args["priorityFeeMicroLamports"]),
      };
    }

    case "transfer_token": {
      const to = key(args["to"], "to");
      const mint = key(args["mint"], "mint");
      if (typeof to === "string") return fail(to);
      if (typeof mint === "string") return fail(mint);
      const places = input.decimals.get(mint.toBase58());
      if (places === undefined)
        return fail(`decimals for mint ${mint.toBase58()} are unknown`);
      const amount = raw(args["amount"], places);
      if (typeof amount === "string") return fail(amount);
      return {
        ok: true,
        tx: compile(wallet, blockhash, [
          createTransferInstruction(
            getAssociatedTokenAddressSync(mint, wallet, true),
            getAssociatedTokenAddressSync(mint, to, true),
            wallet,
            amount,
            [],
            TOKEN_PROGRAM_ID,
          ),
        ], args["priorityFeeMicroLamports"]),
      };
    }

    case "approve": {
      const account = key(args["account"], "account");
      const delegate = key(args["delegate"], "delegate");
      const mint = key(args["mint"], "mint");
      if (typeof account === "string") return fail(account);
      if (typeof delegate === "string") return fail(delegate);
      if (typeof mint === "string") return fail(mint);
      const places = input.decimals.get(mint.toBase58());
      if (places === undefined)
        return fail(`decimals for mint ${mint.toBase58()} are unknown`);
      const amount = raw(args["amount"], places);
      if (typeof amount === "string") return fail(amount);
      return {
        ok: true,
        tx: compile(wallet, blockhash, [
          createApproveInstruction(
            account,
            delegate,
            wallet,
            amount,
            [],
            TOKEN_PROGRAM_ID,
          ),
        ], args["priorityFeeMicroLamports"]),
      };
    }

    case "revoke": {
      const account = key(args["account"], "account");
      if (typeof account === "string") return fail(account);
      return {
        ok: true,
        tx: compile(
          wallet,
          blockhash,
          [createRevokeInstruction(account, wallet, [], TOKEN_PROGRAM_ID)],
          args["priorityFeeMicroLamports"],
        ),
      };
    }

    case "close_account": {
      const account = key(args["account"], "account");
      const destination = key(args["destination"], "destination");
      if (typeof account === "string") return fail(account);
      if (typeof destination === "string") return fail(destination);
      return {
        ok: true,
        tx: compile(
          wallet,
          blockhash,
          [
            createCloseAccountInstruction(
              account,
              destination,
              wallet,
              [],
              TOKEN_PROGRAM_ID,
            ),
          ],
          args["priorityFeeMicroLamports"],
        ),
      };
    }

    case "burn_tokens": {
      const account = key(args["account"], "account");
      const mint = key(args["mint"], "mint");
      if (typeof account === "string") return fail(account);
      if (typeof mint === "string") return fail(mint);
      const places = input.decimals.get(mint.toBase58());
      if (places === undefined)
        return fail(`decimals for mint ${mint.toBase58()} are unknown`);
      const amount = raw(args["amount"], places);
      if (typeof amount === "string") return fail(amount);
      return {
        ok: true,
        tx: compile(
          wallet,
          blockhash,
          [
            createBurnInstruction(
              account,
              mint,
              wallet,
              amount,
              [],
              TOKEN_PROGRAM_ID,
            ),
          ],
          args["priorityFeeMicroLamports"],
        ),
      };
    }

    case "set_authority": {
      const account = key(args["account"], "account");
      if (typeof account === "string") return fail(account);
      const named = args["authority"];
      const kind =
        typeof named === "string" ? AUTHORITY_TYPES[named] : undefined;
      if (kind === undefined)
        return fail("authority must be owner, close, mint or freeze");
      // Absent means renounce, which is irreversible and a legitimate thing
      // to do on purpose -- so it is expressible rather than blocked here.
      const raw = args["newAuthority"];
      let next: PublicKey | null = null;
      if (typeof raw === "string" && raw !== "") {
        const parsed = key(raw, "newAuthority");
        if (typeof parsed === "string") return fail(parsed);
        next = parsed;
      }
      return {
        ok: true,
        tx: compile(
          wallet,
          blockhash,
          [
            createSetAuthorityInstruction(
              account,
              wallet,
              kind,
              next,
              [],
              TOKEN_PROGRAM_ID,
            ),
          ],
          args["priorityFeeMicroLamports"],
        ),
      };
    }

    case "freeze_account": {
      const account = key(args["account"], "account");
      const mint = key(args["mint"], "mint");
      if (typeof account === "string") return fail(account);
      if (typeof mint === "string") return fail(mint);
      return {
        ok: true,
        tx: compile(
          wallet,
          blockhash,
          [
            createFreezeAccountInstruction(
              account,
              mint,
              wallet,
              [],
              TOKEN_PROGRAM_ID,
            ),
          ],
          args["priorityFeeMicroLamports"],
        ),
      };
    }

    default:
      return fail(`no builder for tool ${input.tool}`);
  }
}
