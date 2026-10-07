import { useEffect, useState } from 'react'
import { motion, useScroll, useSpring } from 'motion/react'
import Scramble from './components/Scramble'
import ScrambleButton from './components/ScrambleButton'
import TxFeed from './components/TxFeed'
import FlowWaveHero from './components/FlowWaveHero'
import StackStrip from './components/StackStrip'
import SpotCard from './components/SpotCard'
import Donut from './components/Donut'
import FrameLoop from './components/FrameLoop'
import Counter from './components/Counter'
import LatencyBars from './components/LatencyBars'
import TxLifecycle from './components/TxLifecycle'
import { Rise, useCurrentSection } from './components/ScrollFx'
import { RevealHeading, ScrollManifesto } from './components/ScrollManifesto'
import SlotTower from './components/SlotTower'
import SmokeHeading from './components/SmokeHeading'
import AttackReel from './components/AttackReel'
import CurrentBand from './components/CurrentBand'
import FooterBadge from './components/FooterBadge'
import FooterInfo from './components/FooterInfo'
import { ATTACKS } from './components/attacks'
import { AnimatePresence } from 'motion/react'
import Logo from './components/Logo'
import ThemeToggle from './components/ThemeToggle'


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

const SECTIONS = [
  ['home', 'Home'], ['cases', 'Cases'], ['feed', 'Verdicts'], ['how', 'Pipeline'], ['lifecycle', 'Lifecycle'],
  ['statement', 'Why'], ['speed', 'Speed'], ['receipt', 'Receipts'], ['attacks', 'Attacks'], ['finale', 'Console'],
] as const
const SECTION_IDS = SECTIONS.map(([id]) => id)

/* The pill names the section in view; its + opens every section as a menu. */
function SectionPill() {
  const cur = useCurrentSection(SECTION_IDS)
  const [open, setOpen] = useState(false)
  const label = SECTIONS.find(([id]) => id === cur)?.[1] ?? 'Home'
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as HTMLElement).closest('.pill')) setOpen(false) }
    addEventListener('click', close); addEventListener('keydown', close)
    return () => { removeEventListener('click', close); removeEventListener('keydown', close) }
  }, [open])
  return (
    <div className="pill">
      <button type="button" className="pill__btn" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        <span className="pill__dot" aria-hidden="true" />
        <span className="pill__label">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={label} initial={{ y: 14, opacity: 0, filter: 'blur(4px)' }} animate={{ y: 0, opacity: 1, filter: 'blur(0px)' }} exit={{ y: -14, opacity: 0, filter: 'blur(4px)' }} transition={{ type: 'spring', stiffness: 420, damping: 32 }}>{label}</motion.span>
          </AnimatePresence>
        </span>
        <motion.span className="pill__plus" animate={{ rotate: open ? 45 : 0 }} aria-hidden="true">+</motion.span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.ul className="pill__menu" role="menu" initial={{ opacity: 0, y: -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.97 }} transition={{ type: 'spring', stiffness: 520, damping: 36 }}>
            {SECTIONS.map(([id, l], i) => (
              <motion.li key={id} role="none" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0, transition: { delay: i * 0.025 } }}>
                <a role="menuitem" href={`#${id}`} className={cur === id ? 'is-on' : ''} onClick={() => setOpen(false)}>
                  <span>{String(i).padStart(2, '0')}</span>{l}
                </a>
              </motion.li>
            ))}
            <li role="none"><a role="menuitem" href="/app/" className="pill__console">Open console →</a></li>
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  )
}

export default function App() {
  const { scrollYProgress } = useScroll()
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 30 })

  return (
    <>
      <motion.div className="progress" style={{ scaleX: progress }} aria-hidden="true" />

      <header className="nav">
        <div className="nav__inner">
        <a href="#home" className="nav__brand" aria-label="AVAL home">
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
          <ThemeToggle />
          <SectionPill />
        </div>
        </div>
      </header>

      <main id="top">
        <FlowWaveHero>
          <div className="wave__copy">
            <p className="wave__tag"><span className="nav__status"><i /> armed</span><span>behavioral EDR · solana</span><Clock /></p>
            <div className="wave__main">
              <h1 className="wave__title">
                <Scramble text="Autonomy for your agent." as="span" delay={300} />
                <Scramble text="Oversight for your money." as="span" className="dim" delay={700} />
              </h1>
              <p className="wave__sub">
                The trust infrastructure for the agent economy: AVAL checks every
                transaction before it's signed and proves every decision on-chain.
              </p>
            </div>
            <div className="wave__cta">
              <ScrambleButton label="Watch it veto" href="#feed" />
              <ScrambleButton label="How it works" href="#how" variant="ghost" />
            </div>
          </div>
        </FlowWaveHero>

        <section id="cases" className="cases">
          <SlotTower />
        </section>

        <div className="flip">
        <section id="feed" className="section split">
          <div className="split__copy">
            <Scramble as="p" text="01 / verdicts" className="kicker" />
            <RevealHeading text="Judged before it lands." />
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
        <StackStrip />
        </div>

        <CurrentBand>
        <section id="how" className="section">
          <Scramble as="p" text="02 / pipeline" className="kicker" />
          <RevealHeading text="Three steps, under a millisecond." className="center" />
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
            <RevealHeading text="Before the signature, not after the block." />
            <p>
              A Solana transaction is irreversible from the moment it is signed and sent: it is forwarded to the
              leader, executed, shredded across the network and voted into the chain in well under a second.
              AVAL is the one step that happens before any of that.
            </p>
          </div>
          <TxLifecycle />
        </section>
        </CurrentBand>

        <section id="statement" className="statement">
          <ScrollManifesto
            kicker="why aval"
            lines={[
              'Autonomous agents now hold wallets.',
              'They read emails, follow links and sign in milliseconds.',
              'AVAL reads what every transaction would actually do,',
              'traces each address to where it came from,',
              'and decides before a single key signs.',
            ]}
          />
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
            <SmokeHeading text="Every verdict shows its work." />
            <p>
              Each decision carries the simulated slot, the balance deltas and a digest
              that matches the transaction's own message digest. Anyone can check that
              the transaction AVAL judged is the one that was signed.
            </p>
          </div>
        </section>

        <section id="attacks" className="section attacks">
          <div className="attacks__head">
            <div>
              <Scramble as="p" text="06 / attacks" className="kicker" />
              <RevealHeading text="Attacks that never get a signature." />
            </div>
            <p className="attacks__lede">
              {ATTACKS.length} ways an agent’s wallet gets emptied, and the engine rule that stops each one.
              Critical findings are <b className="hot">denied</b> on their own; a high finding is <b className="flagc">held</b> for a person,
              and two of them deny.
            </p>
          </div>
          <AttackReel />
          <p className="attacks__hint">hover to scrub · click an attack to open it · ← → with the keyboard</p>
        </section>

        <section id="finale">
          <Rise className="finale">
            <div className="finale__top">
              <div>
                <p className="kicker">the console</p>
                <RevealHeading text="Run it on your own agents." className="finale__h" />
              </div>
              <div className="finale__cta">
                <ScrambleButton label="Open the console" href="/app/" />
                <ScrambleButton label="Back to the top" href="#home" variant="ghost" />
              </div>
            </div>
            <div className="finale__screen">
              <FooterInfo />
              <FooterBadge />
            </div>
            <footer className="footer">
              <span>AVAL · built for VETO · Superteam Brasil 2026</span>
              <span className="footer__links"><a href="#feed">Verdicts</a><a href="#lifecycle">Lifecycle</a><a href="/app/">Console</a></span>
              <span>EOF</span>
            </footer>
          </Rise>
        </section>
      </main>
    </>
  )
}
