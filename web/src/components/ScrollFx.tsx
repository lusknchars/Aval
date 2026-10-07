import { useEffect, useRef, useState, type ReactNode } from 'react'
import { motion, useMotionValueEvent, useScroll, useSpring, useTransform } from 'motion/react'
import { useReduced } from '../lib/useReduced'

/* Scroll-driven transitions between landing sections. All of them settle into
   a readable resting state, and reduced motion gets that state directly. */

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
