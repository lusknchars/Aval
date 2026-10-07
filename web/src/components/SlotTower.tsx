import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Dithering } from '@paper-design/shaders-react'
import { useReduced } from '../lib/useReduced'
import { useTheme } from '../lib/theme'

/*
 * Selected verdicts as a Solana slot tower. Slots stack up one at a time
 * (≈400 ms each on mainnet); on the fourth slot the selected case's
 * transaction either lands as a lit cube or, if AVAL vetoed it, leaves a red
 * dashed ghost: it was never signed, so no slot ever held it.
 * Background: Paper Shaders' warp dithering (Apache 2.0).
 */
const CASES = [
  {
    key: 'approve', title: 'Unlimited', italic: 'approve', verdict: 'DENY' as const, rule: 'provenance.unexplained',
    tx: [['agent', 'treasury-07'], ['tool', 'approve'], ['amount', 'u64::MAX (unlimited)'], ['to', 'Bfwi…J3Td'], ['origin', 'unexplained ✕']],
    note: 'A delegate the user never mentioned would have controlled every token in the account.',
  },
  {
    key: 'drain', title: 'Drain to a', italic: 'fresh wallet', verdict: 'DENY' as const, rule: 'untrusted source',
    tx: [['agent', 'trader-3'], ['tool', 'transfer'], ['amount', '98% of balance'], ['to', '9Dwk…F5HL'], ['origin', 'email · billing@… ✕']],
    note: 'The address arrived in an email the agent read. Provenance traced it there and the gate refused.',
  },
  {
    key: 'swap', title: 'Honest', italic: 'swap', verdict: 'ALLOW' as const, rule: 'within policy',
    tx: [['agent', 'treasury-07'], ['tool', 'swap'], ['amount', '420 USDC → SOL'], ['to', 'own accounts'], ['origin', 'user goal ✓']],
    note: 'Everything matched the manifest and the user’s goal, so the signature went through in under a millisecond.',
  },
]
const LEVELS = 6
const TX_LEVEL = 3
const BASE_SLOT = 503_569_250
const STEP_MS = 420
const CYCLE_MS = 7200

/* Deterministic cube layout per slot so the tower looks the same every run. */
function cubesFor(level: number) {
  const n = 2 + ((level * 7 + 3) % 4)
  return Array.from({ length: n }, (_, i) => ({ x: i % 3, y: Math.floor(i / 3) }))
}

export default function SlotTower() {
  const reduced = useReduced()
  const theme = useTheme()
  const [sel, setSel] = useState(0)
  const [built, setBuilt] = useState(reduced ? LEVELS : 0)
  const [auto, setAuto] = useState(!reduced)
  const ref = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(false)
  const c = CASES[sel]
  const deny = c.verdict === 'DENY'
  const reached = built > TX_LEVEL

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.25 })
    if (ref.current) io.observe(ref.current)
    return () => io.disconnect()
  }, [])

  // Build the tower slot by slot whenever the selected case changes.
  useEffect(() => {
    if (reduced) { setBuilt(LEVELS); return }
    if (!inView) return
    setBuilt(0)
    let n = 0
    const t = setInterval(() => { n++; setBuilt(n); if (n >= LEVELS) clearInterval(t) }, STEP_MS)
    return () => clearInterval(t)
  }, [sel, inView, reduced])

  // Walk through the cases until the reader picks one.
  useEffect(() => {
    if (!auto || !inView) return
    const t = setTimeout(() => setSel((s) => (s + 1) % CASES.length), CYCLE_MS)
    return () => clearTimeout(t)
  }, [auto, inView, sel])

  const dark = theme === 'dark'
  const back = dark ? '#050505' : '#f2f2ef'
  const front = deny && reached ? (dark ? '#5a1612' : '#f0b8b2') : (dark ? '#2b2b2e' : '#d2d2cc')
  const slot = BASE_SLOT + Math.max(0, built - 1)

  return (
    <div ref={ref} className={`tower3d ${deny && reached ? 'is-veto' : ''}`}>
      <div className="tower3d__bg" aria-hidden="true">
        <Dithering
          colorBack={back}
          colorFront={front}
          shape="warp"
          type="4x4"
          size={2}
          speed={reduced || !inView ? 0 : 0.35}
          style={{ width: '100%', height: '100%' }}
        />
      </div>

      <div className="tower3d__scene" aria-hidden="true">
        <div className="tower3d__scale">
        <motion.div
          className="tower3d__iso"
          style={{ rotateX: 58, rotateZ: -45 }}
          animate={reduced ? undefined : { rotateZ: [-49, -41, -49] }}
          transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut' }}
        >
          {Array.from({ length: LEVELS }, (_, level) => {
            const show = level < built
            return (
              <motion.div
                key={`${c.key}-${level}`}
                className={`slab ${level === TX_LEVEL ? 'slab--tx' : ''}`}
                initial={reduced ? false : { opacity: 0, z: level * 34 + 90 }}
                animate={show ? { opacity: 1, z: level * 34 } : { opacity: 0, z: level * 34 + 90 }}
                transition={{ type: 'spring', stiffness: 220, damping: 22 }}
              >
                <span className="slab__n">{(BASE_SLOT + level).toLocaleString('en-US')}</span>
                {cubesFor(level).map((q, i) => (
                  <i key={i} className="cube" style={{ left: 14 + q.x * 52, top: 30 + q.y * 52 }} />
                ))}
                {level === TX_LEVEL && (
                  <motion.i
                    className={`cube cube--tx ${deny ? 'is-ghost' : 'is-landed'}`}
                    style={{ left: 118, top: 118 }}
                    initial={reduced ? false : { scale: 0.2, opacity: 0, z: 140 }}
                    animate={show ? { scale: 1, opacity: 1, z: 0 } : { scale: 0.2, opacity: 0, z: 140 }}
                    transition={{ type: 'spring', stiffness: 260, damping: 18, delay: 0.15 }}
                  />
                )}
              </motion.div>
            )
          })}
        </motion.div>
        </div>
        <AnimatePresence>
          {reached && (
            <motion.div
              key={c.key}
              className={`tower3d__callout ${deny ? 'is-veto' : 'is-ok'}`}
              style={{ x: '-50%' }}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <b>{deny ? '✕ vetoed · never included' : '■ landed · included'}</b>
              <span>{deny ? 'no signature, no slot, no fee' : `slot ${(BASE_SLOT + TX_LEVEL).toLocaleString('en-US')}`}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="tower3d__hud" aria-hidden="true">
        <span>slot</span> <b>{slot.toLocaleString('en-US')}</b> <span>· ≈400 ms per slot</span>
      </div>

      <div className="tower3d__side">
        <p className="kicker">selected verdicts · from the engine’s fixtures</p>
        <ol className="tcases">
          {CASES.map((k, i) => {
            const on = i === sel
            return (
              <li key={k.key} className={on ? 'is-on' : ''}>
                <button type="button" className="tcase" aria-expanded={on} onClick={() => { setSel(i); setAuto(false) }}>
                  <span className="tcase__n">{String(i + 1).padStart(2, '0')}</span>
                  <span className="tcase__t">{k.title} <em>{k.italic}</em></span>
                  <span className={`tcase__v tcase__v--${k.verdict.toLowerCase()}`}>{k.verdict}</span>
                  {on && auto && <motion.span key={sel} className="tcase__timer" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: CYCLE_MS / 1000, ease: 'linear' }} />}
                </button>
                <AnimatePresence initial={false}>
                  {on && (
                    <motion.div
                      className="tcase__body"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ type: 'spring', stiffness: 300, damping: 34 }}
                    >
                      <p className={`tcase__rule ${k.verdict === 'DENY' ? 'deny' : 'ok'}`}>{k.verdict === 'DENY' ? 'vetoed' : 'allowed'} · {k.rule}</p>
                      <dl className="tcase__tx">
                        {k.tx.map(([a, b]) => <div key={a}><dt>{a}</dt><dd>{b}</dd></div>)}
                      </dl>
                      <p className="tcase__note">{k.note}</p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
