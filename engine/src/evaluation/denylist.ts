/**
 * Addresses a human decided never to transact with.
 *
 * This is the only mechanism in the system where accumulated observation is
 * allowed to change a decision, and it is allowed precisely because a PERSON
 * put the entry there. The review queue can show that an address appeared
 * forty times; it cannot promote it. A counter that denies on its own is a
 * weapon for whoever can make the counter go up -- flood a customer's own
 * deposit address with flagged activity and their withdrawals stop.
 *
 * So the queue proposes, a human approves, and what the human approved lands
 * here as configuration. The version of the policy changes with it, which is
 * what makes "why was this denied in March" answerable.
 *
 * It matches on ANY address the transaction touches, not only counterparties.
 * A deny-list is the operator's own explicit statement, and the conservative
 * reading of "never deal with this address" is the one that also covers an
 * account it merely writes to. Over-matching here costs a denial the operator
 * asked for; under-matching costs the thing they were trying to prevent.
 *
 * The check kind is `provenance` because this is a statement about WHO an
 * address is, which is that check's subject. The vocabulary of check kinds is
 * closed, and this did not need a new one.
 */
import type { EffectSet } from "../types/effects.js";
import type { Finding } from "../types/verdict.js";

export function denylistFindings(
  set: EffectSet,
  denylist: readonly string[],
): readonly Finding[] {
  if (denylist.length === 0) return [];
  const denied = new Set(denylist);
  const hits = new Map<string, string[]>();

  const hit = (address: string | undefined, role: string): void => {
    if (address === undefined || !denied.has(address)) return;
    const roles = hits.get(address) ?? [];
    if (!roles.includes(role)) roles.push(role);
    hits.set(address, roles);
  };

  for (const effect of set.effects) {
    hit(effect.account, "account");
    hit(effect.owner, "owner");
    hit(effect.counterparty, "counterparty");
  }
  hit(set.feePayer ?? undefined, "fee payer");

  return [...hits].map(([address, roles]) => ({
    check: "provenance",
    severity: "critical",
    rule: "denylist.address",
    detail: {
      // Named `counterparty` so the review queue groups it with everything
      // else about this address instead of opening a second item for it.
      counterparty: address,
      roles: [...roles].sort((a, b) => a.localeCompare(b)),
      note: "an operator put this address on the deny-list",
    },
  }));
}
