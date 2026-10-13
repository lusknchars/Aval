/**
 * Which accounts a tool was allowed to touch.
 *
 * The other manifest checks ask WHAT happened -- an effect the manifest does
 * not list, an amount above what was declared. This one asks WHERE. It exists
 * because `may` patterns are necessarily loose: `close_account` has to accept
 * a balance decrease it cannot describe in advance, and `approve` has to
 * accept the rent it pays. A pattern with no account constraint matches that
 * effect on ANY account, which is the hole -- an approve that also drains a
 * second token account of the caller's matches `may` and passes.
 *
 * Scope closes it by asking a question the manifest already answers:
 * `accountScope` says whether the tool may go beyond the addresses it was
 * given, and the arguments say what those addresses are.
 *
 * WHAT "DERIVED" MEANS HERE. Two things, and both are proofs rather than
 * guesses:
 *
 *   - the associated token account of an address argument and a mint
 *     argument, derived with the same maths the chain uses;
 *   - any token account whose OWNER, read out of its own bytes in the
 *     simulated state, is an address argument. This one is stronger than the
 *     derivation: it covers a token account that is not the associated one,
 *     which is perfectly legitimate and which no address maths can predict.
 *
 * A PDA belonging to some third-party program is NOT derivable -- the seeds
 * live in that program's source. So a manifest whose tool genuinely routes
 * through accounts nobody can enumerate has to say `open` and mean it, rather
 * than claim a scope this code would have to fail open on.
 */
import { PublicKey } from "@solana/web3.js";
import type { ToolCall } from "../types/context.js";
import type { Effect, EffectType } from "../types/effects.js";
import type { ToolManifest } from "../types/manifest.js";
import type { Finding, Severity } from "../types/verdict.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../normalization/spl.js";

const ASSOCIATED_TOKEN_PROGRAM_ID =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/**
 * How bad it is that a PERMITTED effect landed on an account outside scope.
 *
 * Only losses are listed. An account that gains value or comes into existence
 * outside the scope is not a loss to anyone, and the provenance check already
 * asks who the beneficiary is at the severity that question deserves --
 * reporting it here too would put a finding on every swap, and a customer who
 * sees findings on every call stops reading them.
 */
const SEVERITY_OUTSIDE_SCOPE: Partial<Readonly<Record<EffectType, Severity>>> = {
  DELEGATE_GRANT: "critical",
  AUTHORITY_CHANGE: "critical",
  OWNER_CHANGE: "critical",
  ACCOUNT_CLOSE: "high",
  ACCOUNT_FREEZE: "high",
  BALANCE_DECREASE: "high",
};

export interface Scope {
  readonly kind: ToolManifest["accountScope"];
  /** Addresses that came straight from the tool call, plus the fee payer. */
  readonly named: ReadonlySet<string>;
  /** Associated token accounts of every (address, mint) pair in the arguments. */
  readonly derived: ReadonlySet<string>;
}

function toPublicKey(value: string): PublicKey | null {
  try {
    return new PublicKey(value);
  } catch {
    // "SOL", an elided display form, or anything else that is not a key. Not
    // an error: the caller simply cannot derive from it.
    return null;
  }
}

/** The associated token account, derived exactly as the chain derives it. */
function associatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): string {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  );
  return address.toBase58();
}

/**
 * The scope a tool call authorises.
 *
 * The fee payer is always inside it. Every transaction charges its payer, so
 * excluding it would report the fee as an out-of-scope loss on every single
 * call -- and the payer is the account doing the asking, not an account the
 * tool wandered into.
 */
export function scopeOf(
  manifest: ToolManifest,
  toolCall: ToolCall,
  feePayer: string,
): Scope {
  const named = new Set<string>();
  if (feePayer !== "") named.add(feePayer);

  const addresses: PublicKey[] = [];
  const mints: PublicKey[] = [];
  for (const [name, type] of Object.entries(manifest.args)) {
    const given = toolCall.args[name];
    if (typeof given !== "string" || given === "") continue;
    if (type !== "address" && type !== "mint") continue;
    named.add(given);
    const key = toPublicKey(given);
    if (key === null) continue;
    if (type === "address") addresses.push(key);
    else mints.push(key);
  }

  const derived = new Set<string>();
  if (manifest.accountScope === "args_plus_derived") {
    for (const owner of addresses) {
      for (const mint of mints) {
        for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
          derived.add(
            associatedTokenAddress(owner, mint, new PublicKey(program)),
          );
        }
      }
    }
  }

  return { kind: manifest.accountScope, named, derived };
}

/** Whether an effect landed on an account this tool call authorised. */
export function inScope(effect: Effect, scope: Scope): boolean {
  // A program is not an account the tool "touched" in any meaningful sense,
  // and which programs are acceptable is the allowlist's question, not this
  // one. Scoping them here would report every CPI twice.
  if (effect.type === "PROGRAM_INVOKE") return true;
  if (scope.kind === "open") return true;
  if (scope.named.has(effect.account)) return true;
  if (scope.kind === "args_only") return false;
  if (scope.derived.has(effect.account)) return true;
  // The token account's own bytes say who controls it. If that is an address
  // the tool call named, the tool is operating on what it was given.
  return effect.owner !== undefined && scope.named.has(effect.owner);
}

/**
 * Findings for effects the manifest PERMITTED that landed outside the scope.
 *
 * Only permitted effects are passed in. An effect no pattern matched is
 * already reported as undeclared, with the account in its detail, and
 * reporting it twice would take two findings off one event -- enough, on its
 * own, to reach the deny threshold.
 */
export function scopeFindings(
  permitted: readonly Effect[],
  manifest: ToolManifest,
  toolCall: ToolCall,
  feePayer: string,
): readonly Finding[] {
  if (manifest.accountScope === "open") return [];
  const scope = scopeOf(manifest, toolCall, feePayer);
  const findings: Finding[] = [];

  for (const effect of permitted) {
    const severity = SEVERITY_OUTSIDE_SCOPE[effect.type];
    if (severity === undefined) continue;
    if (inScope(effect, scope)) continue;
    findings.push({
      check: "scope",
      severity,
      rule: `scope.outside_${manifest.accountScope}`,
      detail: {
        tool: manifest.tool,
        effect: effect.type,
        account: effect.account,
        owner: effect.owner ?? null,
        amount: effect.amount === undefined ? null : effect.amount.toString(),
        authorised: [...scope.named].sort((a, b) => a.localeCompare(b)),
      },
    });
  }

  return findings;
}
