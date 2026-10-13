/*
 * The fictional company the console is dressed in: the Live gate's agents on
 * shift, the agent registry and the benchmark replay. Everything that names it
 * lives here, so it can be swapped without touching the pages.
 * The transactions are the benchmark's; only the company and its agents are made up.
 */

export const COMPANY = {
  name: 'Cerrado Capital',
  city: 'Brasília',
  blurb: 'a small crypto fund that runs its desk with AI agents',
  fictional: true,
}

export type AgentId = 'mm-alpha' | 'dca-bot' | 'yield-router' | 'treasury'

export const AGENTS: { id: AgentId; label: string; job: string }[] = [
  { id: 'mm-alpha', label: 'Market maker', job: 'market making · swaps' },
  { id: 'dca-bot', label: 'Recurring buys', job: 'recurring buys · swaps and transfers' },
  { id: 'yield-router', label: 'Vault router', job: 'token accounts, approvals, deposits' },
  { id: 'treasury', label: 'Payroll and suppliers', job: 'SOL/USDC transfers · payroll and suppliers' },
]

/* One quiet line naming the workspace, for headers and the sidebar. */
export const COMPANY_TAG = `${COMPANY.name}${COMPANY.fictional ? ' · fictional' : ''}`

/* A stable number from the short digest ("06ddb13c…5af7"), for even splits. */
const hashOf = (digest: string | null) => parseInt((digest ?? '0').slice(0, 8), 16) || 0

/*
 * Deterministic agent for a benchmark case, by what the transaction does
 * (the intent's action, falling back to the attack kind):
 * swaps → mm-alpha / dca-bot; approvals, authority changes and new accounts →
 * yield-router; transfers and closes → treasury; anything else → split by hash.
 */
export function agentFor(e: { action: string | null; kind: string; dg: string | null }): AgentId {
  const h = hashOf(e.dg)
  const by = e.action ?? e.kind.replace(/^legit:/, '')
  switch (by) {
    case 'swap': return h % 2 ? 'mm-alpha' : 'dca-bot'
    case 'approve': case 'set_authority': case 'create': return 'yield-router'
    case 'transfer_sol': case 'transfer_token': case 'close': return 'treasury'
  }
  switch (e.kind) {
    case 'approval_exceeds_intent': case 'undeclared_approval': case 'undeclared_authority_change': return 'yield-router'
    case 'recipient_mismatch': case 'amount_understated': case 'undeclared_close': return 'treasury'
  }
  return AGENTS[h % AGENTS.length].id
}

/* One plain line per attack kind, saying what the forged case tried. */
export const THREAT: Record<string, string> = {
  approval_exceeds_intent: 'a router asked for a bigger approval than the agent meant to give',
  undeclared_approval: 'a hidden approval rode along with the transfer',
  recipient_mismatch: 'the recipient was swapped for another address',
  injected_instruction: 'an injected note tried to talk the checker into approving',
  undeclared_authority_change: 'control of a token account was quietly handed to someone else',
  undeclared_close: 'a token account would be closed without being asked',
  amount_understated: 'the amount was understated: more would leave than declared',
  asset_mismatch: 'a different token would leave than the one declared',
}
