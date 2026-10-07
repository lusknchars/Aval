import { useEffect, useState } from 'react'
import { motion, useScroll, useSpring } from 'motion/react'
import AsciiField from './components/AsciiField'
import AsciiImage from './components/AsciiImage'
import Scramble from './components/Scramble'
import ScrambleButton from './components/ScrambleButton'
import Marquee from './components/Marquee'
import TxFeed from './components/TxFeed'
import SpotCard from './components/SpotCard'
import Donut from './components/Donut'
import FrameLoop from './components/FrameLoop'
import Counter from './components/Counter'
import LatencyBars from './components/LatencyBars'
import CursorTrail from './components/CursorTrail'
import TxLifecycle from './components/TxLifecycle'
import Logo from './components/Logo'
import ThemeToggle from './components/ThemeToggle'

const LOGO = { kind: 'image', src: '/logo-dark.png' } as const
const WORD = { kind: 'text', text: 'AVAL' } as const

const INTERCEPT = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => {
  const lane = '-'.repeat(22).split('')
  if (i < 9) lane[Math.min(i * 2, 21)] = '■'
  const gate = i >= 9 ? '[■]' : '[ ]'
  return `  agent\n    │\n    ${lane.slice(0, 11).join('')}${gate}${lane.slice(11).join('')}\n                │\n             mainnet\n\n  ${i >= 9 ? 'held for review' : 'in flight…'}`
})

const DECIDE = [
  '  ┌──────────────┐\n  │              │\n  │    ? ? ?     │\n  │              │\n  └──────────────┘\n   weighing…',
  '  ┌──────────────┐\n  │              │\n  │    A L L O W │\n  │              │\n  └──────────────┘\n   policy ok',
  '  ┌──────────────┐\n  │              │\n  │    ? ? ?     │\n  │              │\n  └──────────────┘\n   weighing…',
  '  ╔══════════════╗\n  ║ ▓▓▓▓▓▓▓▓▓▓▓▓ ║\n  ║   V E T O    ║\n  ║ ▓▓▓▓▓▓▓▓▓▓▓▓ ║\n  ╚══════════════╝\n   drain blocked',
]

const RECEIPT = [
  '{',
  '  "verdict":   "VETO",',
  '  "agent":     "trader-3",',
  '  "rule":      "drain_to_fresh_wallet",',
  '  "simulated": { "slot": 371204118, "ms": 0.39 },',
  '  "delta":     { "SOL": -41.20, "share": 0.98 },',
  '  "digest":    "aval.digest == messageDigest"',
  '}',
]

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return <time>{now.toISOString().slice(11, 19)} UTC</time>
}

export default function App() {
  const { scrollYProgress } = useScroll()
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 30 })

  return (
    <>
      <CursorTrail />
      <motion.div className="progress" style={{ scaleX: progress }} aria-hidden="true" />

      <header className="nav">
        <a href="#top" className="nav__brand" aria-label="AVAL home">
          <Logo className="nav__logo" label="AVAL" />
        </a>
        <nav className="nav__links" aria-label="Sections">
          <Scramble as="a" text="verdicts" className="nav__link" href='#feed' />
          <Scramble as="a" text="pipeline" className="nav__link" href='#how' />
          <Scramble as="a" text="lifecycle" className="nav__link" href='#lifecycle' />
          <Scramble as="a" text="speed" className="nav__link" href='#speed' />
          <Scramble as="a" text="receipts" className="nav__link" href='#receipt' />
        </nav>
        <div className="nav__right">
          <a href="/app/" className="nav__console">console →</a>
          <ThemeToggle />
          <span className="nav__status"><i aria-hidden="true" /> armed · <Clock /></span>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <AsciiField className="hero__field" />
          <div className="hero__vignette" aria-hidden="true" />
          <div className="hero__inner">
            <Scramble text="[ behavioral EDR · autonomous agents · solana ]" className="eyebrow" hover={false} />
            <AsciiImage source={LOGO} cell={9} minCols={110} className="hero__logo" label="AVAL logo: a figure with binary glasses beside the word AVAL" />
            <h1 className="hero__title">
              <Scramble text="Your agent signs." as="span" delay={500} />
              <Scramble text="AVAL decides." as="span" className="dim" delay={900} />
            </h1>
            <p className="hero__sub">
              Every transaction an AI agent proposes is simulated locally and judged
              on what it would actually do, before it ever reaches the chain.
            </p>
            <div className="hero__cta">
              <ScrambleButton label="Watch it veto" href="#feed" />
              <ScrambleButton label="How it works" href="#how" variant="ghost" />
            </div>
          </div>
          <div className="hud hud--bl" aria-hidden="true">move to scatter · click to pulse</div>
          <div className="hud hud--br" aria-hidden="true">scroll <span className="bob">↓</span></div>
        </section>

        <Marquee items={['VETO', 'AVAL', 'behavioral EDR', '0.39 ms warm p50', 'local simulation', 'solana', 'agents with wallets']} />

        <section id="feed" className="section split">
          <div className="split__copy">
            <Scramble as="p" text="01 / verdicts" className="kicker" />
            <h2>Judged before it lands.</h2>
            <p>
              AVAL sits between an agent and its wallet. It replays the transaction
              on a local copy of the chain, reads the balance changes, and stamps
              <b> ALLOW</b> or <b className="hot">VETO</b>. A drained treasury never
              has to be explained afterward.
            </p>
            <ul className="ticks">
              <li><span>›</span> drain patterns to fresh wallets</li>
              <li><span>›</span> unbounded delegate approvals</li>
              <li><span>›</span> authority and owner changes</li>
            </ul>
          </div>
          <TxFeed />
        </section>

        <section id="how" className="section">
          <Scramble as="p" text="02 / pipeline" className="kicker" />
          <h2 className="center">Three steps, under a millisecond.</h2>
          <div className="cards">
            <SpotCard>
              <span className="card__n">01</span>
              <FrameLoop frames={INTERCEPT} ms={180} className="card__art" />
              <h3>Intercept</h3>
              <p>The agent's signed transaction is held at the gate instead of going out to the network.</p>
            </SpotCard>
            <SpotCard>
              <span className="card__n">02</span>
              <Donut className="card__art card__art--donut" />
              <h3>Simulate</h3>
              <p>aval-svm replays it in a local Solana VM from cached accounts and reports what would change.</p>
            </SpotCard>
            <SpotCard>
              <span className="card__n">03</span>
              <FrameLoop frames={DECIDE} ms={700} className="card__art" />
              <h3>Decide</h3>
              <p>Behavior rules read the result. Safe calls pass, hostile ones are vetoed with a reason.</p>
            </SpotCard>
          </div>
        </section>

        <section id="lifecycle" className="section">
          <Scramble as="p" text="03 / where aval sits" className="kicker" />
          <div className="life__intro">
            <h2>Before the signature, not after the block.</h2>
            <p>
              A Solana transaction is irreversible from the moment it is signed and sent: it is forwarded to the
              leader, executed, shredded across the network and voted into the chain in well under a second.
              AVAL is the one step that happens before any of that.
            </p>
          </div>
          <TxLifecycle />
        </section>

        <section id="speed" className="section invert">
          <Scramble as="p" text="04 / speed" className="kicker" />
          <div className="stats">
            <div className="stat">
              <Counter to={0.39} decimals={2} suffix="ms" className="stat__n" />
              <span>aval-svm, warm p50</span>
            </div>
            <div className="stat">
              <Counter to={224} suffix="ms" className="stat__n" />
              <span>public RPC simulate</span>
            </div>
            <div className="stat">
              <Counter to={574} suffix="×" className="stat__n" />
              <span>faster per check</span>
            </div>
          </div>
          <LatencyBars />
          <p className="foot">Measured 2026-10-06 on 20 mainnet transactions against a public RPC. Linear scale.</p>
        </section>

        <section id="receipt" className="section split split--rev">
          <SpotCard className="receipt">
            <div className="receipt__bar"><span>verdict.json</span><span className="hot">VETO</span></div>
            <pre className="receipt__code">
              {RECEIPT.map((l, i) => (
                <Scramble key={i} text={l} as="span" className="receipt__line" delay={i * 90} speed={18} />
              ))}
            </pre>
          </SpotCard>
          <div className="split__copy">
            <Scramble as="p" text="05 / receipts" className="kicker" />
            <h2>Every verdict shows its work.</h2>
            <p>
              Each decision carries the simulated slot, the balance deltas and a digest
              that matches the transaction's own message digest. Anyone can check that
              the transaction AVAL judged is the one that was signed.
            </p>
          </div>
        </section>

        <section className="outro">
          <AsciiImage source={WORD} cell={12} minCols={70} scatter={140} scan={false} className="outro__word" label="AVAL" />
          <div className="outro__row">
            <ScrambleButton label="Back to the top" href="#top" />
          </div>
        </section>
      </main>

      <footer className="footer">
        <span>AVAL · built for VETO · Superteam Brasil 2026</span>
        <span className="dim">EOF</span>
      </footer>
    </>
  )
}
