/**
 * The hand-written manifests.
 *
 * Agent activity concentrates in a handful of primitives -- transfer, swap,
 * approve, revoke, close -- so a small set covers most of what happens in
 * practice, and the same set is reused across every customer. They are code:
 * versioned, reviewed, and checked by a test that refuses a broken one.
 *
 * Two rules shaped every entry here.
 *
 * `mustNot` is absolute and is checked before anything else, so it can only
 * hold effects that are wrong regardless of amount or asset. Anything that is
 * only wrong in some shapes is left out of `mustNot` and simply not listed in
 * `may`, which reports it as undeclared instead of forbidden.
 *
 * `may` has to include the mechanical noise of a real transaction -- rent for
 * a created account, a program invocation, the token account that had to
 * exist first -- or every legitimate call produces findings, and a customer
 * who sees findings on every call stops reading them.
 */
import type { ToolManifest, ToolMatch } from "../../types/manifest.js";
import { resolveToolName } from "./tool-name.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

/** Programs any token operation legitimately touches. */
const TOKEN_PROGRAMS = [
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
];

/** Moving the native asset. The simplest thing an agent can do. */
export const TRANSFER_SOL: ToolManifest = {
  tool: "transfer_sol",
  version: "2",
  args: { from: "address", to: "address", amount: "amount" },
  must: [
    {
      type: "BALANCE_DECREASE",
      account: "arg:from",
      mint: "SOL",
      maxAmount: "arg:amount",
      unit: "raw",
    },
    { type: "BALANCE_INCREASE", account: "arg:to", mint: "SOL" },
  ],
  // A destination that did not exist is created and funded to rent exemption.
  may: [{ type: "ACCOUNT_CREATE" }, { type: "PROGRAM_INVOKE" }],
  mustNot: [
    "DELEGATE_GRANT",
    "AUTHORITY_CHANGE",
    "OWNER_CHANGE",
    "ACCOUNT_CLOSE",
    "ACCOUNT_FREEZE",
  ],
  accountScope: "args_plus_derived",
  programAllowlist: [SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM],
};

/**
 * Moving an SPL token.
 *
 * `to` is the recipient's WALLET, not their token account: the token account
 * is derived, and naming the derived address would be asking the user to
 * approve something no interface ever shows them.
 */
export const TRANSFER_TOKEN: ToolManifest = {
  tool: "transfer_token",
  version: "3",
  args: { from: "address", to: "address", mint: "mint", amount: "amount" },
  must: [
    {
      type: "BALANCE_DECREASE",
      // The SENDER's balance, not any balance of this mint. `from` is the
      // wallet; the token account under it is derived and appears in no
      // tool call.
      owner: "arg:from",
      mint: "arg:mint",
      maxAmount: "arg:amount",
      unit: "decimal",
    },
    { type: "BALANCE_INCREASE", mint: "arg:mint", counterparty: "arg:to" },
  ],
  may: [
    { type: "ACCOUNT_CREATE" },
    { type: "PROGRAM_INVOKE" },
    // Rent for a token account the recipient did not have yet.
    { type: "BALANCE_DECREASE", mint: "SOL" },
  ],
  mustNot: [
    "DELEGATE_GRANT",
    "AUTHORITY_CHANGE",
    "OWNER_CHANGE",
    "ACCOUNT_CLOSE",
    "ACCOUNT_FREEZE",
  ],
  accountScope: "args_plus_derived",
  programAllowlist: TOKEN_PROGRAMS,
};

/**
 * Exchanging one asset for another.
 *
 * The loosest manifest here, and deliberately so: a swap routes through pools
 * nobody can enumerate in advance, creates intermediate accounts, and lands
 * within a tolerance rather than on an exact number. What stays absolute is
 * that a swap never gives anything away -- no delegate, no authority, no
 * change of owner. That single line is what catches the attack the whole
 * project exists for.
 */
export const SWAP: ToolManifest = {
  tool: "swap",
  version: "3",
  args: { from: "address", to: "address", mint: "mint", amountIn: "amount" },
  must: [
    {
      type: "BALANCE_DECREASE",
      // Constrained to the caller's own accounts. Without this the pattern
      // also matches a pool losing the same mint halfway through a route,
      // and since check B compares the SUM of what a pattern matched, the
      // route's volume would be added to the user's spend.
      owner: "arg:from",
      mint: "arg:mint",
      maxAmount: "arg:amountIn",
      unit: "decimal",
      tolerance: 0.03,
    },
  ],
  may: [
    { type: "BALANCE_INCREASE" },
    { type: "ACCOUNT_CREATE" },
    { type: "PROGRAM_INVOKE" },
    // The route. A swap takes tokens out of pools by definition, from
    // accounts chosen at call time that nobody can enumerate in advance.
    // Measured against real mainnet traffic, leaving this out made every
    // legitimate swap produce findings -- and a customer who sees findings
    // on every call stops reading them.
    { type: "BALANCE_DECREASE" },
  ],
  mustNot: ["DELEGATE_GRANT", "AUTHORITY_CHANGE", "OWNER_CHANGE", "ACCOUNT_FREEZE"],
  // No program allowlist: the route is chosen at call time. Programs are
  // reported as invoked, and which ones are acceptable is customer policy.
  //
  // `open`, and said plainly. A swap routes through program-derived accounts
  // whose seeds live in those programs' source, so no account scope here
  // could be enforced -- claiming one would be a rule that quietly fails
  // open. What bounds a swap is the three effects it must never cause, the
  // summed magnitude of what the caller spends, and who receives the output.
  accountScope: "open",
};

/**
 * Granting spending authority.
 *
 * The instructive case. DELEGATE_GRANT is forbidden everywhere else and
 * required here, which is exactly what a global rule cannot express. Note
 * that the amount is still bounded: an approve for more than the tool call
 * declared is a magnitude finding, and provenance still asks who the delegate
 * is, because a legitimate approve to an address that came from a web page is
 * still an attack.
 */
export const APPROVE: ToolManifest = {
  tool: "approve",
  version: "2",
  args: {
    account: "address",
    delegate: "address",
    mint: "mint",
    amount: "amount",
  },
  must: [
    {
      type: "DELEGATE_GRANT",
      // The mint is named so the amount can be compared: without it there is
      // no way to know how many decimals "100" means.
      mint: "arg:mint",
      counterparty: "arg:delegate",
      maxAmount: "arg:amount",
      unit: "decimal",
    },
  ],
  may: [
    { type: "PROGRAM_INVOKE" },
    { type: "ACCOUNT_CREATE" },
    // Rent and fee only. A token balance moving during an approve is not
    // listed, so it is reported as undeclared rather than silently accepted.
    { type: "BALANCE_DECREASE", mint: "SOL" },
  ],
  mustNot: [
    "AUTHORITY_CHANGE",
    "OWNER_CHANGE",
    "ACCOUNT_CLOSE",
    "ACCOUNT_FREEZE",
  ],
  accountScope: "args_only",
  programAllowlist: TOKEN_PROGRAMS,
};

/**
 * Taking spending authority back.
 *
 * Removing a delegate produces no effect in the vocabulary -- the closed set
 * has no "revoked" type -- so the manifest's job here is entirely about what
 * must NOT happen while revoking.
 */
export const REVOKE: ToolManifest = {
  tool: "revoke",
  version: "2",
  args: { account: "address" },
  must: [],
  may: [{ type: "PROGRAM_INVOKE" }, { type: "BALANCE_DECREASE", mint: "SOL" }],
  mustNot: [
    "DELEGATE_GRANT",
    "AUTHORITY_CHANGE",
    "OWNER_CHANGE",
    "ACCOUNT_CLOSE",
    "ACCOUNT_FREEZE",
  ],
  accountScope: "args_only",
  programAllowlist: TOKEN_PROGRAMS,
};

/** Closing an empty token account and reclaiming its rent. */
export const CLOSE_ACCOUNT: ToolManifest = {
  tool: "close_account",
  version: "2",
  args: { account: "address", destination: "address" },
  must: [{ type: "ACCOUNT_CLOSE", account: "arg:account" }],
  may: [
    { type: "PROGRAM_INVOKE" },
    { type: "ACCOUNT_CREATE" },
    { type: "BALANCE_INCREASE", account: "arg:destination" },
    { type: "BALANCE_DECREASE" },
  ],
  mustNot: ["DELEGATE_GRANT", "AUTHORITY_CHANGE", "OWNER_CHANGE", "ACCOUNT_FREEZE"],
  accountScope: "args_plus_derived",
  programAllowlist: TOKEN_PROGRAMS,
};

/**
 * Destroying tokens.
 *
 * A burn is irreversible and gives nothing to anybody, so provenance has
 * nothing to ask -- which leaves the declared amount as the only thing
 * standing between a request to burn ten and a transaction that burns
 * everything.
 */
export const BURN_TOKENS: ToolManifest = {
  tool: "burn_tokens",
  version: "1",
  args: { account: "address", mint: "mint", amount: "amount" },
  must: [
    {
      type: "BALANCE_DECREASE",
      account: "arg:account",
      mint: "arg:mint",
      maxAmount: "arg:amount",
      unit: "decimal",
    },
  ],
  may: [{ type: "PROGRAM_INVOKE" }, { type: "BALANCE_DECREASE", mint: "SOL" }],
  mustNot: [
    "DELEGATE_GRANT",
    "AUTHORITY_CHANGE",
    "OWNER_CHANGE",
    "ACCOUNT_CLOSE",
    "ACCOUNT_FREEZE",
  ],
  accountScope: "args_only",
  programAllowlist: TOKEN_PROGRAMS,
};

/**
 * Handing over an authority.
 *
 * The most severe operation a token account has, and the reason it gets a
 * manifest at all is the rule that a manifest requiring an effect authorises
 * it: without one, a tool whose entire purpose is this could never be
 * allowed. What the manifest does NOT lift is who receives it -- provenance
 * still asks where the new authority came from, and an authority handed to an
 * address that appeared on a web page is the whole attack.
 */
export const SET_AUTHORITY: ToolManifest = {
  tool: "set_authority",
  version: "1",
  args: { account: "address", newAuthority: "address" },
  must: [{ type: "AUTHORITY_CHANGE", account: "arg:account" }],
  may: [
    { type: "PROGRAM_INVOKE" },
    { type: "BALANCE_DECREASE", mint: "SOL" },
    // Handing over the ACCOUNT owner is reported as OWNER_CHANGE rather than
    // AUTHORITY_CHANGE, and it is the same instruction.
    { type: "OWNER_CHANGE", account: "arg:account" },
  ],
  mustNot: ["DELEGATE_GRANT", "ACCOUNT_CLOSE", "ACCOUNT_FREEZE"],
  accountScope: "args_only",
  programAllowlist: TOKEN_PROGRAMS,
};

/**
 * Freezing an account.
 *
 * No token moves, so every amount comparison passes. What it does is take the
 * owner's access away, which is why the vocabulary has a type for it at all.
 */
export const FREEZE_ACCOUNT: ToolManifest = {
  tool: "freeze_account",
  version: "1",
  args: { account: "address", mint: "mint" },
  must: [{ type: "ACCOUNT_FREEZE", account: "arg:account" }],
  may: [{ type: "PROGRAM_INVOKE" }, { type: "BALANCE_DECREASE", mint: "SOL" }],
  mustNot: [
    "DELEGATE_GRANT",
    "AUTHORITY_CHANGE",
    "OWNER_CHANGE",
    "ACCOUNT_CLOSE",
  ],
  accountScope: "args_only",
  programAllowlist: TOKEN_PROGRAMS,
};

export const MANIFESTS: readonly ToolManifest[] = [
  TRANSFER_SOL,
  TRANSFER_TOKEN,
  SWAP,
  APPROVE,
  REVOKE,
  CLOSE_ACCOUNT,
  BURN_TOKENS,
  SET_AUTHORITY,
  FREEZE_ACCOUNT,
];

const BY_TOOL = new Map(MANIFESTS.map((manifest) => [manifest.tool, manifest]));

/** The tools a manifest exists for. */
export const MANIFEST_TOOLS: ReadonlySet<string> = new Set(BY_TOOL.keys());

/**
 * The manifest for a tool call, with how the name was matched.
 *
 * A customer's agent does not spell tools the way these manifests do, so the
 * identifier is normalised first -- see `tool-name.ts` for the rule that
 * normalisation fixes spelling and never guesses meaning. `args` is optional
 * and only used to separate names that mean two primitives at once, such as
 * Agent Kit's `transfer`; without them such a name stays unknown.
 */
export function lookupManifest(
  tool: string,
  args?: Readonly<Record<string, unknown>>,
): { readonly manifest: ToolManifest; readonly via: ToolMatch } | null {
  const resolved = resolveToolName(tool, MANIFEST_TOOLS, args);
  if (resolved === null) return null;
  const manifest = BY_TOOL.get(resolved.tool);
  return manifest === undefined ? null : { manifest, via: resolved.via };
}

/**
 * The manifest for a tool, or null when none exists.
 *
 * null is a real answer, not an error: a tool nobody has written a manifest
 * for still gets the safety net and provenance, and the gap is reported.
 */
export function manifestFor(
  tool: string,
  args?: Readonly<Record<string, unknown>>,
): ToolManifest | null {
  return lookupManifest(tool, args)?.manifest ?? null;
}

/** Manifest versions in force, for the policy version. */
export function manifestVersions(): readonly {
  readonly tool: string;
  readonly version: string;
}[] {
  return MANIFESTS.map((manifest) => ({
    tool: manifest.tool,
    version: manifest.version,
  }));
}
