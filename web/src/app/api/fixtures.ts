import type { Review, Trace } from './types'
import transferSol from '../snapshots/trace-transfer-sol.json'
import unlimitedApprove from '../snapshots/trace-unlimited-approve.json'
import closeAccount from '../snapshots/trace-close-account.json'
import tokenToWallet from '../snapshots/trace-token-to-wallet.json'
import rentFailure from '../snapshots/trace-rent-failure.json'
import createAta from '../snapshots/trace-create-ata.json'
import review from '../snapshots/review.json'

/* The six transactions the Veto demo server ships as fixtures. Snapshots are
   real engine output recorded on 2026-10-06, used when the server is offline. */
export const FIXTURES = [
  { name: 'transfer-sol', title: 'Transfer SOL', blurb: 'Native SOL leaves the wallet for another address.', art: '◎ ──▶ ◎' },
  { name: 'token-to-wallet', title: 'Token to wallet', blurb: 'Wrapped SOL lands in a freshly created account.', art: '▣ ──▶ ◎' },
  { name: 'unlimited-approve', title: 'Unlimited approve', blurb: 'A delegate gets authority over the full u64 amount.', art: '◎ ══∞═▶ ?' },
  { name: 'create-ata', title: 'Create token account', blurb: 'An associated token account is opened and funded.', art: '+ ▣' },
  { name: 'close-account', title: 'Close account', blurb: 'A token account is closed and its rent reclaimed.', art: '▣ ─✕' },
  { name: 'rent-failure', title: 'Rent failure', blurb: 'A transaction that would fail if sent right now.', art: '◎ ─/─ ✕' },
] as const

export const SNAPSHOT_TRACES: Record<string, Trace> = {
  'transfer-sol': transferSol as Trace,
  'unlimited-approve': unlimitedApprove as Trace,
  'close-account': closeAccount as Trace,
  'token-to-wallet': tokenToWallet as Trace,
  'rent-failure': rentFailure as Trace,
  'create-ata': createAta as Trace,
}

export const SNAPSHOT_REVIEW = review as Review
