/**
 * Tool identifiers, as frameworks actually spell them.
 *
 * `manifestFor` used to be an exact-name lookup, and a customer's agent does
 * not spell tools the way our manifests do. The same operation appears in
 * Solana Agent Kit as `transfer`, `TRANSFER`, `TRANSFER_ACTION` and
 * `SolanaTransferTool`; their own published documentation carries stale names.
 * Without normalisation nothing matches on a real integration and every call
 * degrades to `coverage.no_manifest` -- which means the checks that do the
 * work never run at all.
 *
 * THE RULE THAT SHAPES THIS FILE: normalisation may fix SPELLING, never guess
 * MEANING. Mapping a token transfer onto the SOL manifest would pick the wrong
 * ceiling, the wrong asset and the wrong counterparty, and a wrong manifest
 * can produce an ALLOW. So there are exactly three mechanisms here:
 *
 *  1. Syntactic canonicalisation -- case, separators, framework prefix and
 *     suffix. `SolanaTransferTool` and `TRANSFER_ACTION` both become
 *     `transfer`. This cannot change which operation is meant.
 *  2. An alias table, reviewed entry by entry, where every alias is a name
 *     some framework uses for EXACTLY the primitive it points at.
 *  3. Argument-based disambiguation for the handful of names that genuinely
 *     mean two different primitives depending on the call.
 *
 * Anything else stays unknown, and unknown keeps degrading to no_manifest.
 * Degrade, never open.
 */
import type { ToolMatch } from "../../types/manifest.js";


/** Framework noise around the operation's real name. */
const STRIP_PREFIXES: readonly string[] = ["solana", "sol_agent", "agent"];
const STRIP_SUFFIXES: readonly string[] = ["tool", "tools", "action", "actions"];

/**
 * The spelling-only form of an identifier.
 *
 * `SolanaTransferTool` -> `transfer`; `TRANSFER_ACTION` -> `transfer`;
 * `transfer-token` -> `transfer_token`.
 *
 * Note `spl` is deliberately NOT stripped: `spl_transfer` means a token
 * transfer, and stripping the prefix would turn it into the ambiguous
 * `transfer` and throw away the only thing that said which asset moved.
 */
export function canonicalToolName(raw: string): string {
  const separated = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[\s\-.:/]+/g, "_");
  let parts = separated
    .toLowerCase()
    .split("_")
    .filter((part) => part !== "");

  // Only ever strip while something is left: a tool literally called "tool"
  // must not normalise to the empty string.
  for (;;) {
    const first = parts[0];
    if (parts.length < 2 || first === undefined || !STRIP_PREFIXES.includes(first))
      break;
    parts = parts.slice(1);
  }
  for (;;) {
    const last = parts[parts.length - 1];
    if (parts.length < 2 || last === undefined || !STRIP_SUFFIXES.includes(last))
      break;
    parts = parts.slice(0, -1);
  }
  return parts.join("_");
}

/**
 * Names that mean exactly one of our primitives.
 *
 * Every entry is a name a framework, an SDK or a published tool schema
 * actually uses. Keys are already in canonical form, so `SPL_TRANSFER` and
 * `splTransferTool` both arrive here as `spl_transfer`.
 *
 * What is NOT here matters as much: no entry maps a generic verb onto a
 * specific asset. `send`, `transfer` and `trade` without further information
 * are handled below, by argument, or not at all.
 */
const ALIASES: Readonly<Record<string, string>> = {
  // native transfer
  transfer_sol: "transfer_sol",
  send_sol: "transfer_sol",
  sol_transfer: "transfer_sol",
  transfer_native: "transfer_sol",
  transfer_lamports: "transfer_sol",

  // token transfer
  transfer_token: "transfer_token",
  transfer_tokens: "transfer_token",
  transfer_spl: "transfer_token",
  transfer_spl_token: "transfer_token",
  spl_transfer: "transfer_token",
  token_transfer: "transfer_token",
  send_token: "transfer_token",
  send_tokens: "transfer_token",
  send_spl_token: "transfer_token",

  // swap
  swap: "swap",
  swap_token: "swap",
  swap_tokens: "swap",
  trade: "swap",
  jupiter_swap: "swap",
  raydium_swap: "swap",
  orca_swap: "swap",

  // delegation
  approve: "approve",
  approve_token: "approve",
  approve_tokens: "approve",
  approve_delegate: "approve",
  token_approve: "approve",
  delegate_token: "approve",

  revoke: "revoke",
  revoke_delegate: "revoke",
  revoke_approval: "revoke",
  revoke_token: "revoke",
  token_revoke: "revoke",

  // closing
  close_account: "close_account",
  close_token_account: "close_account",
  close_empty_account: "close_account",
  close_empty_token_accounts: "close_account",

  // burning
  burn: "burn_tokens",
  burn_token: "burn_tokens",
  burn_tokens: "burn_tokens",
  burn_spl_token: "burn_tokens",

  // authority
  set_authority: "set_authority",
  set_token_authority: "set_authority",
  set_mint_authority: "set_authority",
  change_authority: "set_authority",
  update_authority: "set_authority",

  // freezing
  freeze: "freeze_account",
  freeze_account: "freeze_account",
  freeze_token_account: "freeze_account",
};

/**
 * Names that mean two different primitives depending on the arguments.
 *
 * Solana Agent Kit's `transfer` moves SOL when no mint is given and an SPL
 * token when one is. There is no spelling that separates them, and choosing
 * one by default would be choosing the wrong manifest half the time. So the
 * call's own arguments decide, and when they are unavailable the answer is
 * "unknown" rather than a guess.
 */
const BY_MINT_ARGUMENT: Readonly<Record<string, { readonly withMint: string; readonly withoutMint: string }>> = {
  transfer: { withMint: "transfer_token", withoutMint: "transfer_sol" },
  send: { withMint: "transfer_token", withoutMint: "transfer_sol" },
  pay: { withMint: "transfer_token", withoutMint: "transfer_sol" },
};

/** Fields a framework might use for the mint of a token operation. */
const MINT_FIELDS: readonly string[] = [
  "mint",
  "mintAddress",
  "tokenMint",
  "token",
  "tokenAddress",
  "splToken",
];

function namesAMint(args: Readonly<Record<string, unknown>>): boolean {
  for (const field of MINT_FIELDS) {
    const value = args[field];
    if (typeof value === "string" && value.trim() !== "") return true;
  }
  return false;
}

export interface ResolvedTool {
  /** The manifest's own tool name. */
  readonly tool: string;
  readonly via: ToolMatch;
}

/**
 * The manifest tool an identifier refers to, or null when it is unknown.
 *
 * `known` is the set of tools manifests exist for, passed in rather than
 * imported so this file stays testable without the manifest set and so an
 * alias can never silently point at a manifest that was deleted.
 */
export function resolveToolName(
  raw: string,
  known: ReadonlySet<string>,
  args?: Readonly<Record<string, unknown>>,
): ResolvedTool | null {
  if (known.has(raw)) return { tool: raw, via: "exact" };

  const canonical = canonicalToolName(raw);
  if (canonical === "") return null;
  if (known.has(canonical)) return { tool: canonical, via: "normalized" };

  const alias = ALIASES[canonical];
  if (alias !== undefined && known.has(alias))
    return { tool: alias, via: "alias" };

  const ambiguous = BY_MINT_ARGUMENT[canonical];
  if (ambiguous !== undefined) {
    // No arguments means no way to tell which primitive this is. Answering
    // anyway would pick the wrong ceiling and the wrong asset.
    if (args === undefined) return null;
    const tool = namesAMint(args) ? ambiguous.withMint : ambiguous.withoutMint;
    return known.has(tool) ? { tool, via: "by_argument" } : null;
  }

  return null;
}

/** Every alias target, for the test that refuses a dangling one. */
export function aliasTargets(): readonly string[] {
  return [
    ...new Set([
      ...Object.values(ALIASES),
      ...Object.values(BY_MINT_ARGUMENT).flatMap((entry) => [
        entry.withMint,
        entry.withoutMint,
      ]),
    ]),
  ];
}

/** Every alias key, for the test that refuses a non-canonical one. */
export function aliasKeys(): readonly string[] {
  return [...Object.keys(ALIASES), ...Object.keys(BY_MINT_ARGUMENT)];
}
