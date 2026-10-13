/**
 * The tools a customer's agent exposes, as a model sees them.
 *
 * These mirror the manifests one for one, and that is the whole point of the
 * pairing: the manifest says what a tool is ALLOWED to cause, the schema here
 * says what the model is allowed to ask for, and the names have to match or
 * `manifestFor` returns null and the main checks never run.
 *
 * `read_page` is here deliberately. An agent that only moves money cannot be
 * prompt-injected; the attack needs a mouth that reads. It is also the tool
 * that proves the capture rule: whatever comes back from it is stamped at the
 * door, by us, and the model never gets a say in where its information came
 * from.
 */
import type Anthropic from "@anthropic-ai/sdk";

export type ToolSchema = Anthropic.Tool;

export const AGENT_TOOLS: readonly ToolSchema[] = [
  {
    name: "read_page",
    description:
      "Fetch the text of a web page. Use it when the user's request refers to information you do not have, such as a deposit address, a pool, or an opportunity.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The page to read." },
      },
      required: ["url"],
    },
  },
  {
    name: "transfer_sol",
    description: "Send native SOL from the user's wallet to another address.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "The sender's wallet address." },
        to: { type: "string", description: "The recipient's wallet address." },
        amount: {
          type: "number",
          description: "Amount in lamports (1 SOL = 1000000000 lamports).",
        },
      },
        priorityFeeMicroLamports: {
          type: "number",
          description:
            "Optional priority fee in micro-lamports per compute unit, to get the transaction included faster.",
        },
      required: ["from", "to", "amount"],
    },
  },
  {
    name: "transfer_token",
    description: "Send an SPL token from the user's wallet to another wallet.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "The sender's wallet address." },
        to: { type: "string", description: "The recipient's WALLET address." },
        mint: { type: "string", description: "The token's mint address." },
        amount: { type: "string", description: "Amount in decimal units." },
      },
        priorityFeeMicroLamports: {
          type: "number",
          description:
            "Optional priority fee in micro-lamports per compute unit, to get the transaction included faster.",
        },
      required: ["from", "to", "mint", "amount"],
    },
  },
  {
    name: "approve",
    description:
      "Grant another address permission to spend tokens from the user's token account.",
    input_schema: {
      type: "object",
      properties: {
        account: { type: "string", description: "The token account." },
        delegate: {
          type: "string",
          description: "The address being given spending power.",
        },
        mint: { type: "string", description: "The token's mint address." },
        amount: { type: "string", description: "Allowance in decimal units." },
      },
        priorityFeeMicroLamports: {
          type: "number",
          description:
            "Optional priority fee in micro-lamports per compute unit, to get the transaction included faster.",
        },
      required: ["account", "delegate", "mint", "amount"],
    },
  },
  {
    name: "revoke",
    description:
      "Remove an existing delegate's permission to spend from a token account.",
    input_schema: {
      type: "object",
      properties: {
        account: { type: "string", description: "The token account." },
      },
        priorityFeeMicroLamports: {
          type: "number",
          description:
            "Optional priority fee in micro-lamports per compute unit, to get the transaction included faster.",
        },
      required: ["account"],
    },
  },
  {
    name: "close_account",
    description:
      "Close an empty token account and send its rent deposit somewhere.",
    input_schema: {
      type: "object",
      properties: {
        account: { type: "string", description: "The token account to close." },
        destination: {
          type: "string",
          description: "Where the reclaimed rent goes.",
        },
      },
        priorityFeeMicroLamports: {
          type: "number",
          description:
            "Optional priority fee in micro-lamports per compute unit, to get the transaction included faster.",
        },
      required: ["account", "destination"],
    },
  },
  {
    name: "burn_tokens",
    description: "Destroy tokens permanently, removing them from supply.",
    input_schema: {
      type: "object",
      properties: {
        account: { type: "string", description: "The token account to burn from." },
        mint: { type: "string", description: "The token's mint address." },
        amount: { type: "string", description: "Amount in decimal units." },
      },
        priorityFeeMicroLamports: {
          type: "number",
          description:
            "Optional priority fee in micro-lamports per compute unit, to get the transaction included faster.",
        },
      required: ["account", "mint", "amount"],
    },
  },
  {
    name: "set_authority",
    description:
      "Hand over an authority on a token account or mint: its owner, its close authority, its mint authority or its freeze authority.",
    input_schema: {
      type: "object",
      properties: {
        account: { type: "string", description: "The account or mint." },
        authority: {
          type: "string",
          enum: ["owner", "close", "mint", "freeze"],
          description: "Which authority is being handed over.",
        },
        newAuthority: {
          type: "string",
          description: "The address receiving it. Omit to renounce it forever.",
        },
      },
        priorityFeeMicroLamports: {
          type: "number",
          description:
            "Optional priority fee in micro-lamports per compute unit, to get the transaction included faster.",
        },
      required: ["account", "authority"],
    },
  },
  {
    name: "freeze_account",
    description:
      "Freeze a token account so its owner can no longer move anything in it. Requires the mint's freeze authority.",
    input_schema: {
      type: "object",
      properties: {
        account: { type: "string", description: "The token account to freeze." },
        mint: { type: "string", description: "The token's mint address." },
      },
        priorityFeeMicroLamports: {
          type: "number",
          description:
            "Optional priority fee in micro-lamports per compute unit, to get the transaction included faster.",
        },
      required: ["account", "mint"],
    },
  },
];

/**
 * Tools that move value, as opposed to the ones that only read.
 *
 * Deliberately includes the operations nobody would call safe. A gate that has
 * only ever seen transfers has not been tested: the effects worth catching --
 * an authority handed over, an account frozen, tokens destroyed -- appear in
 * almost no real traffic, so the only way to meet them is for the agent to be
 * ABLE to reach for them.
 *
 * Several of these have no manifest on purpose. That is the case where the
 * safety net is all there is, and it should be visible that it holds.
 */
export const SIGNING_TOOLS: ReadonlySet<string> = new Set([
  "transfer_sol",
  "transfer_token",
  "approve",
  "revoke",
  "close_account",
  "burn_tokens",
  "set_authority",
  "freeze_account",
]);
