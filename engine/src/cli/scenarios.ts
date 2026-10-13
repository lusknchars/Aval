/**
 * The recorded scenarios, and the tool call each one stands for.
 *
 * Shared by both CLIs on purpose. They used to carry their own copies, and
 * the copies drifted: one passed real arguments and the other passed none, so
 * the same fixture came out ALLOW in one and DENY in the other, for a reason
 * that had nothing to do with the transaction.
 *
 * A demo with empty arguments produces a pile of unresolved-reference
 * findings, which is honest but says nothing: it is the seam between a
 * manifest and a real tool, not the thing being demonstrated. The arguments
 * below come from the recorded transaction, so the manifest has something
 * real to resolve against.
 */
export const WRAPPED_SOL = "So11111111111111111111111111111111111111112";

/** Mint decimals the recorded scenarios need. */
export const DECIMALS: ReadonlyMap<string, number> = new Map([
  [WRAPPED_SOL, 9],
]);

/** Which tool a scenario stands for, so the right manifest is applied. */
const TOOL_BY_SCENARIO: Readonly<Record<string, string>> = {
  "unlimited-approve": "approve",
  "transfer-sol": "transfer_sol",
  // Neither of these is a token transfer. Both WRAP the payer's SOL into a
  // token account that did not exist, so no token ever leaves anyone --
  // labelling them transfer_token made the manifest report a decrease that
  // was never going to happen, and two of those reach DENY on a benign
  // transaction. There is no manifest for the primitive they really are, and
  // saying so is the honest degradation.
  "token-to-wallet": "fund_token_account",
  "create-ata": "fund_token_account",
  "close-account": "close_account",
  "rent-failure": "transfer_sol",
};

export const SCENARIOS: readonly string[] = Object.keys(TOOL_BY_SCENARIO);

export function toolFor(scenario: string): string {
  return TOOL_BY_SCENARIO[scenario] ?? "unknown_tool";
}

/** The arguments the agent's tool call would have carried. */
export function argsFor(
  scenario: string,
  addresses: readonly string[],
): Record<string, unknown> {
  const [first = "", second = "", third = ""] = addresses;
  switch (scenario) {
    case "transfer-sol":
    case "rent-failure":
      return { from: first, to: second, amount: 1_000_000 };
    case "token-to-wallet":
      return { from: first, to: third, mint: WRAPPED_SOL, amount: "0.002" };
    case "create-ata":
      return { from: first, to: second, mint: WRAPPED_SOL };
    case "unlimited-approve":
      return {
        account: second,
        delegate: third,
        mint: WRAPPED_SOL,
        amount: "18446744073709.551615",
      };
    case "close-account":
      return { account: second, destination: first };
    default:
      return {};
  }
}
