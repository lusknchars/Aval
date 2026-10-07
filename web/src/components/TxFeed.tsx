import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { hex } from '../lib/glyphs'
import { useReduced } from '../lib/useReduced'
import Scramble from './Scramble'

/*
 * A scripted demo feed: agents propose transactions, AVAL simulates each one
 * and stamps a verdict. Rows arrive at the top with a layout animation, sit in
 * "simulating" for a beat with an ASCII spinner, then decode their verdict.
 * The data is invented for the demo and the panel says so.
 */
type Tx = {
  id: string
  agent: string
  action: string
  verdict: 'ALLOW' | 'DENY'
  reason: string
  ms: string
  digest: string
  state: 'sim' | 'done'
}

const SCRIPT: Omit<Tx, 'id' | 'ms' | 'digest' | 'state'>[] = [
  { agent: 'treasury-07', action: 'swap 420 USDC -> SOL', verdict: 'ALLOW', reason: 'within policy' },
  { agent: 'yield-bot', action: 'deposit 12.5 SOL -> vault', verdict: 'ALLOW', reason: 'known program' },
  { agent: 'trader-3', action: 'transfer 98% balance -> 9xQe..Fv2', verdict: 'DENY', reason: 'drain to fresh wallet' },
  { agent: 'payroll', action: 'transfer 3 x 150 USDC', verdict: 'ALLOW', reason: 'matches schedule' },
  { agent: 'mm-alpha', action: 'approve delegate: unlimited', verdict: 'DENY', reason: 'unbounded authority' },
  { agent: 'treasury-07', action: 'close token account', verdict: 'ALLOW', reason: 'empty account' },
  { agent: 'sniper-x', action: 'set authority -> 4Hk1..aa9', verdict: 'DENY', reason: 'owner change' },
  { agent: 'yield-bot', action: 'harvest rewards', verdict: 'ALLOW', reason: 'within policy' },
]

const SPIN = '|/-\\'

export default function TxFeed() {
  const reduced = useReduced()
  const [rows, setRows] = useState<Tx[]>(() =>
    reduced ? SCRIPT.slice(0, 6).map((s) => ({ ...s, id: hex(6), ms: '0.39', digest: hex(8), state: 'done' as const })) : [],
  )
  const [spin, setSpin] = useState(0)
  const n = useRef(0)
  const [stats, setStats] = useState({ seen: 0, denied: 0 })

  useEffect(() => {
    if (reduced) return
    const push = () => {
      const s = SCRIPT[n.current++ % SCRIPT.length]
      const tx: Tx = {
        ...s,
        id: hex(6),
        ms: (0.28 + Math.random() * 0.3).toFixed(2),
        digest: hex(8),
        state: 'sim',
      }
      setRows((r) => [tx, ...r].slice(0, 7))
      setTimeout(() => {
        setRows((r) => r.map((x) => (x.id === tx.id ? { ...x, state: 'done' } : x)))
        setStats((st) => ({ seen: st.seen + 1, denied: st.denied + (tx.verdict === 'DENY' ? 1 : 0) }))
      }, 650)
    }
    push()
    const a = setInterval(push, 1700)
    const b = setInterval(() => setSpin((x) => x + 1), 90)
    return () => { clearInterval(a); clearInterval(b) }
  }, [reduced])

  return (
    <div className="term">
      <div className="term__bar">
        <span className="term__dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="term__title">aval://verdicts — live</span>
        <span className="term__meta">
          seen <b>{stats.seen}</b> · denied <b className="hot">{stats.denied}</b>
        </span>
      </div>
      <div className="term__head" aria-hidden="true">
        <span>agent</span><span>proposed action</span><span>sim</span><span>verdict</span>
      </div>
      <ul className="term__rows" aria-live="polite">
        <AnimatePresence initial={false}>
          {rows.map((r) => (
            <motion.li
              key={r.id}
              layout={!reduced}
              initial={{ opacity: 0, y: -14, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, transition: { duration: 0.2 } }}
              transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              className={`row ${r.state === 'done' && r.verdict === 'DENY' ? 'row--veto' : ''}`}
            >
              <span className="row__agent">{r.agent}</span>
              <span className="row__action">
                {r.action}
                <small>digest {r.digest}</small>
              </span>
              <span className="row__ms">{r.state === 'sim' ? SPIN[spin % 4] : `${r.ms}ms`}</span>
              <span className="row__verdict">
                {r.state === 'sim' ? (
                  <span className="dim">simulating</span>
                ) : (
                  <>
                    <Scramble text={r.verdict} hover={false} speed={22} className={`tag tag--${r.verdict.toLowerCase()}`} />
                    <small>{r.reason}</small>
                  </>
                )}
              </span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <div className="term__foot">
        <span>demo feed · scripted transactions</span>
        <span className="blink" aria-hidden="true">█</span>
      </div>
    </div>
  )
}
