import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useReduced } from '../lib/useReduced'
import Scramble from './Scramble'

/*
 * A Solana transaction's life, with AVAL inserted where it really sits: after
 * the agent asks for a signature and before anything reaches an RPC. Laid out
 * as a loop (top row left→right, bottom row right→left), a packet walks the
 * stages. In the drain scenario it is stopped at the gate and every later
 * stage never happens.
 */
type Scenario = 'honest' | 'drain'
const STAGES = [
  { k: 'agent', title: 'Agent', sub: 'wallet + tools', what: 'The agent builds a transaction from what it was asked and what it read, then asks its wallet to sign.' },
  { k: 'aval', title: 'AVAL gate', sub: 'before the signature', what: 'AVAL simulates the unsigned transaction locally, reads what it would change, traces every address to its source and checks the tool’s manifest. Only an allowed transaction gets a signature.' },
  { k: 'gulf', title: 'Gulf Stream', sub: 'RPC → upcoming leaders', what: 'There is no mempool: RPC nodes forward the signed transaction straight to the validators scheduled to lead the next slots, weighted by stake.' },
  { k: 'build', title: 'Block building', sub: 'the leader’s pipeline', what: 'The leader fetches, verifies signatures, executes in parallel banking lanes and records entries into the Proof of History stream, then broadcasts.' },
  { k: 'turbine', title: 'Turbine', sub: 'shred fan-out', what: 'The block is cut into shreds and fanned out through a tree of validators, so no single node has to send it to everyone.' },
  { k: 'verify', title: 'Block verification', sub: 'every validator', what: 'Validators fetch shreds, verify the leader’s signature, retransmit downstream and replay the block against their own accounts database.' },
  { k: 'consensus', title: 'Consensus', sub: 'votes, forks, root', what: 'Validators vote on forks. Losing forks are pruned; once enough stake builds on a block it becomes rooted, and the transfer is final.' },
  { k: 'confirm', title: 'Confirmation', sub: 'back to the agent', what: 'The agent learns the result. For an honest swap that is a landed, rooted transaction. For a drain it is a refusal that happened before any key signed.' },
] as const
// Grid placement of the snake: top row 0..3 left→right, bottom row 7..4 left→right.
const POS = [[1, 1], [1, 2], [1, 3], [1, 4], [2, 4], [2, 3], [2, 2], [2, 1]]
const STEP_MS = 1500

export default function TxLifecycle() {
  const reduced = useReduced()
  const [scenario, setScenario] = useState<Scenario>('honest')
  const [stage, setStage] = useState(0)
  const [playing, setPlaying] = useState(!reduced)
  const [pinned, setPinned] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  const vetoed = scenario === 'drain'
  // In the drain run the packet stops at the gate; stages after it never happen.
  const reachable = (i: number) => !vetoed || i <= 1 || i === 7

  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => {
      setStage((s) => {
        if (vetoed) return s === 0 ? 1 : s === 1 ? 7 : s === 7 ? 0 : 0
        return (s + 1) % STAGES.length
      })
    }, STEP_MS)
    return () => clearInterval(t)
  }, [playing, vetoed])
  useEffect(() => {
    if (reduced) return
    const t = setInterval(() => setTick((x) => x + 1), 220)
    return () => clearInterval(t)
  }, [reduced])

  const focus = pinned ?? stage
  const restart = (s: Scenario) => { setScenario(s); setStage(0); setPinned(null); setPlaying(!reduced) }

  return (
    <div className={`life life--${scenario}`}>
      <div className="life__bar">
        <div className="life__seg" role="group" aria-label="Scenario">
          {(['honest', 'drain'] as Scenario[]).map((s) => (
            <button key={s} type="button" aria-pressed={scenario === s} className={scenario === s ? 'is-on' : ''} onClick={() => restart(s)}>
              {scenario === s && <motion.span layoutId="life-seg" className="life__seghl" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
              <span>{s === 'honest' ? 'Honest swap' : 'Drain attempt'}</span>
            </button>
          ))}
        </div>
        <button type="button" className="life__play" onClick={() => { setPlaying((p) => !p); setPinned(null) }} aria-label={playing ? 'Pause the walkthrough' : 'Play the walkthrough'}>
          {playing ? '❚❚ pause' : '▶ play'}
        </button>
      </div>

      <ol className="life__grid" aria-label="Transaction lifecycle">
        {STAGES.map((s, i) => {
          const [row, col] = POS[i]
          const on = focus === i
          const dead = !reachable(i)
          return (
            <li key={s.k} className={`lstage lstage--${s.k} ${on ? 'is-on' : ''} ${dead ? 'is-dead' : ''} ${i < stage && reachable(i) ? 'is-past' : ''}`} style={{ gridRow: row, gridColumn: col }}>
              <button type="button" className="lstage__btn" onClick={() => { setPinned(i); setPlaying(false) }} aria-label={`${s.title}: ${s.what}`}>
                <span className="lstage__n">{String(i + 1).padStart(2, '0')}</span>
                <span className="lstage__title">{s.title}</span>
                <span className="lstage__sub">{dead ? 'never happens' : s.sub}</span>
                <span className="lstage__art" aria-hidden="true"><Art k={s.k} tick={tick} vetoed={vetoed} active={stage === i} /></span>
              </button>
            </li>
          )
        })}
        {/* connectors: 0→1→2→3 across, 3↓4, 4→5→6→7 back, 7↑0 */}
        {[0, 1, 2].map((i) => <Wire key={`a${i}`} dir="right" row={1} col={i + 1} live={stage === i + 1 && reachable(i + 1)} dead={!reachable(i + 1)} veto={vetoed && i === 1} />)}
        <Wire dir="down" row={1} col={4} live={stage === 4} dead={vetoed} />
        {[4, 5, 6].map((i) => <Wire key={`b${i}`} dir="left" row={2} col={POS[i][1]} live={stage === i + 1 && reachable(i + 1)} dead={vetoed} />)}
        <Wire dir="up" row={1} col={1} live={stage === 0} dead={false} />
      </ol>

      <AnimatePresence mode="wait">
        <motion.div
          key={`${focus}-${scenario}`}
          className="life__cap"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.25 }}
          aria-live="polite"
        >
          <span className="life__capk">{String(focus + 1).padStart(2, '0')} · {STAGES[focus].title}</span>
          <p>{!reachable(focus) ? 'Never reached. The drain was refused at the AVAL gate, so nothing was signed, broadcast or paid for.' : STAGES[focus].what}</p>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

function Wire({ dir, row, col, live, dead, veto }: { dir: 'right' | 'left' | 'down' | 'up'; row: number; col: number; live: boolean; dead: boolean; veto?: boolean }) {
  return (
    <span className={`lwire lwire--${dir} ${live ? 'is-live' : ''} ${dead ? 'is-dead' : ''} ${veto ? 'is-veto' : ''}`} style={{ gridRow: row, gridColumn: col }} aria-hidden="true">
      <i className="lwire__line" />
      <i className="lwire__dot" />
      {veto && <b className="lwire__x">✕</b>}
    </span>
  )
}

/* Small per-stage animations, drawn with text so they stay in the ASCII language. */
function Art({ k, tick, vetoed, active }: { k: string; tick: number; vetoed: boolean; active: boolean }) {
  const blink = tick % 2 === 0
  const lines: Record<string, ReactNode> = {
    agent: (
      <pre>{`wallet   420.00 USDC
agent    treasury-07
build    ${vetoed ? 'transfer 98% → 9xQe…' : 'swap 420 USDC → SOL'}
sign?    ${active ? (blink ? '▶ asking' : '  asking') : '·'}`}</pre>
    ),
    aval: (
      <div className="lart-aval">
        <pre>{`simulate  aval-svm   ${active ? '0.39ms' : '······'}
effects   ${vetoed ? '−98% balance' : '−420 USDC +SOL'}
origin    ${vetoed ? 'unexplained ✕' : 'user goal ✓'}
manifest  ${vetoed ? 'drain pattern' : 'within policy'}`}</pre>
        <span className={`lart-stamp ${vetoed ? 'is-veto' : 'is-allow'}`}>
          {vetoed ? <Scramble text="VETO" hover={false} speed={40} /> : <Scramble text="ALLOW" hover={false} speed={40} />}
        </span>
      </div>
    ),
    gulf: (
      <pre>{['1.5%', '2.0%', '3.0%', '1.0%', '0.5%'].map((s, i) => `rpc ─▶ ${s.padStart(4)} stake ${i === 2 ? (active ? '◀ leader' : '◀') : ''}`).join('\n')}</pre>
    ),
    build: (
      <pre>{`fetch ▸ sigverify ▸ bank
${[0, 1, 2, 3].map((l) => `  [${'■'.repeat(((tick + l * 2) % 5) + 1).padEnd(6, '·')}] entry`).join('\n')}
PoH #${(503569250 + tick).toLocaleString('en-US')} ▸ broadcast`}</pre>
    ),
    turbine: (
      <pre>{`        L
        0
     ${tick % 3 === 1 ? '[1]' : ' 1 '} ${tick % 3 === 0 ? '[2]' : ' 2 '} ${tick % 3 === 2 ? '[3]' : ' 3 '}
   4 5 6  7 8 9  10 11
       ↓ shreds ×${(tick % 9) + 4}`}</pre>
    ),
    verify: (
      <pre>{`shred fetch ${active || tick % 4 > 0 ? '✓' : '·'}
verify sig  ${active || tick % 4 > 1 ? '✓' : '·'}
retransmit  ${active || tick % 4 > 2 ? '✓' : '·'}
replay ▸ AccountsDB`}</pre>
    ),
    consensus: (
      <pre>{`slot 0  1  2  3  4  5
     ■──■──■──■     ■
        ╰─□ pruned   ╰─ ${blink ? 'rooted' : '      '}`}</pre>
    ),
    confirm: (
      <pre className={vetoed ? 'lart-refused' : ''}>{vetoed
        ? `refused before signing
broadcast   none
fee paid    0 SOL
funds lost  0`
        : `landed      slot 503,569,250
status      rooted
fee         0.000005 SOL
verdict     ALLOW · p1-7d21f0`}</pre>
    ),
  }
  return <>{lines[k]}</>
}
