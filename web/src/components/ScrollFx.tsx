import { useEffect, useRef, useState, type ReactNode } from 'react'
import { motion, useMotionValueEvent, useScroll, useSpring, useTransform } from 'motion/react'
import { useReduced } from '../lib/useReduced'
import AsciiField from './AsciiField'

/* Scroll-driven transitions between landing sections. All of them settle into
   a readable resting state, and reduced motion gets that state directly. */

/** Oversized type that slides sideways as the section passes. */
export function Divider({ text, dir = -1 }: { text: string; dir?: 1 | -1 }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReduced()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] })
  const x = useTransform(scrollYProgress, [0, 1], dir < 0 ? ['8%', '-42%'] : ['-42%', '8%'])
  const words = Array.from({ length: 4 }, () => text)
  return (
    <div ref={ref} className="divider" aria-hidden="true">
      <motion.div className="divider__track" style={reduced ? undefined : { x }}>
        {words.map((w, i) => <span key={i} className={i % 2 ? 'is-italic' : ''}>{w}</span>)}
      </motion.div>
    </div>
  )
}

/**
 * Letters ride a wave into place as the line scrolls toward the middle of the
 * screen. One scroll listener writes every letter's transform directly, so
 * long lines do not cost one motion value per character.
 */
export function WaveText({ text, className = '' }: { text: string; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null)
  const chars = useRef<(HTMLSpanElement | null)[]>([])
  const reduced = useReduced()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 0.95', 'center 0.5'] })
  const p = useSpring(scrollYProgress, { stiffness: 120, damping: 26 })
  const n = text.length
  const paint = (v: number) => {
    const K = 14 // letters in flight at once
    for (let i = 0; i < n; i++) {
      const el = chars.current[i]
      if (!el) continue
      const local = Math.max(0, Math.min(1, (v * (n + K) - i) / K))
      const e = 1 - Math.pow(1 - local, 3)
      el.style.transform = `translateY(${(1 - e) * 0.9}em) rotate(${(1 - e) * 24}deg)`
      el.style.opacity = String(0.08 + e * 0.92)
    }
  }
  useMotionValueEvent(p, 'change', (v) => { if (!reduced) paint(v) })
  useEffect(() => { paint(reduced ? 1 : p.get()) }, [reduced])
  // Index letters across the whole line (spaces count) so `paint` lines up.
  const words: { c: string; i: number }[][] = []
  let i = 0
  for (const w of text.split(' ')) { words.push(w.split('').map((c) => ({ c, i: i++ }))); i++ }
  return (
    <p ref={ref} className={`wave ${className}`} aria-label={text}>
      {words.map((w, wi) => (
        <span key={wi} className="wave__word" aria-hidden="true">
          {w.map(({ c, i }) => <span key={i} ref={(el) => { chars.current[i] = el }} className="wave__ch">{c}</span>)}
        </span>
      ))}
    </p>
  )
}

/* ── blob showcase: three transactions, alternating sides ───────────── */
const CASES = [
  { title: 'Unlimited', italic: 'approve', verdict: 'DENY', rule: 'provenance.unexplained', art: `agent  treasury-07
tool   approve
amount u64::MAX  (unlimited)
to     Bfwi…J3Td
origin unexplained  ✕`, note: 'A delegate the user never mentioned would have controlled every token in the account.' },
  { title: 'Drain to a', italic: 'fresh wallet', verdict: 'DENY', rule: 'untrusted source', art: `agent  trader-3
tool   transfer
amount 98% of balance
to     9Dwk…F5HL
origin email · billing@…  ✕`, note: 'The address arrived in an email the agent read. Provenance traced it there and the gate refused.' },
  { title: 'Honest', italic: 'swap', verdict: 'ALLOW', rule: 'within policy', art: `agent  treasury-07
tool   swap
amount 420 USDC → SOL
to     own accounts
origin user goal  ✓`, note: 'Everything matched the manifest and the user’s goal, so the signature went through in under a millisecond.' },
]

const BLOBS = [
  ['48% 52% 44% 56% / 52% 46% 54% 48%', '56% 44% 58% 42% / 44% 58% 42% 56%'],
  ['60% 40% 52% 48% / 46% 54% 46% 54%', '44% 56% 40% 60% / 56% 42% 58% 44%'],
  ['52% 48% 60% 40% / 58% 44% 56% 42%', '46% 54% 48% 52% / 48% 56% 44% 52%'],
]

function BlobCase({ c, i }: { c: (typeof CASES)[number]; i: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReduced()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] })
  const y = useTransform(scrollYProgress, [0, 1], [90, -90])
  const scale = useTransform(scrollYProgress, [0, 0.45, 1], [0.82, 1, 0.94])
  const radius = useTransform(scrollYProgress, [0, 1], BLOBS[i % BLOBS.length])
  const ty = useTransform(scrollYProgress, [0, 1], [40, -40])
  const right = i % 2 === 1
  return (
    <div ref={ref} className={`bcase ${right ? 'bcase--right' : ''}`}>
      <motion.div className={`bcase__blob ${c.verdict === 'DENY' ? 'is-deny' : 'is-allow'}`} style={reduced ? undefined : { y, scale, borderRadius: radius }}>
        <AsciiField className="bcase__field" cell={12} intensity={0.55} />
        <pre className="bcase__art">{c.art}</pre>
        <span className={`bcase__stamp ${c.verdict === 'DENY' ? 'is-deny' : 'is-allow'}`}>{c.verdict}</span>
      </motion.div>
      <motion.div className="bcase__copy" style={reduced ? undefined : { y: ty }}>
        <span className="bcase__n">{String(i + 1).padStart(2, '0')}</span>
        <h3 className="bcase__title">{c.title}<em>{c.italic}</em></h3>
        <p className="bcase__rule">{c.verdict === 'DENY' ? 'vetoed · ' : 'allowed · '}{c.rule}</p>
        <p className="bcase__note">{c.note}</p>
      </motion.div>
    </div>
  )
}

export function BlobShowcase() {
  return <div className="bshow">{CASES.map((c, i) => <BlobCase key={c.italic} c={c} i={i} />)}</div>
}

/** Section the header pill should name, by the ids passed in. */
export function useCurrentSection(ids: readonly string[]) {
  const [cur, setCur] = useState(ids[0])
  useEffect(() => {
    const io = new IntersectionObserver((xs) => {
      const v = xs.filter((x) => x.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
      if (v) setCur(v.target.id)
    }, { rootMargin: '-35% 0px -55% 0px', threshold: [0, 0.25, 0.5, 1] })
    ids.forEach((id) => { const el = document.getElementById(id); if (el) io.observe(el) })
    return () => io.disconnect()
  }, [ids.join()])
  return cur
}

export function Rise({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReduced()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'start 0.4'] })
  const y = useTransform(scrollYProgress, [0, 1], [120, 0])
  const r = useTransform(scrollYProgress, [0, 1], [48, 20])
  const s = useTransform(scrollYProgress, [0, 1], [0.94, 1])
  return (
    <motion.div ref={ref} className={className} style={reduced ? undefined : { y, borderTopLeftRadius: r, borderTopRightRadius: r, scale: s }}>
      {children}
    </motion.div>
  )
}
