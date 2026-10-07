import { useEffect, useRef, type ElementType } from 'react'
import { motion, useInView, useMotionValueEvent, useScroll, useSpring } from 'motion/react'
import { NOISE } from '../lib/glyphs'
import { useReduced } from '../lib/useReduced'

/*
 * Pinned manifesto: the section sticks while the page scrolls past it, and the
 * paragraph is written letter by letter by the scroll position. Each letter
 * arrives as noise, resolves to itself, and goes from blurred and dim to ink.
 * One listener writes every letter directly; nothing re-renders per frame.
 */
export function ScrollManifesto({ lines, kicker }: { lines: string[]; kicker: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const chars = useRef<(HTMLSpanElement | null)[]>([])
  const counter = useRef<HTMLSpanElement>(null)
  const bar = useRef<HTMLSpanElement>(null)
  const reduced = useReduced()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] })
  const p = useSpring(scrollYProgress, { stiffness: 140, damping: 30, restDelta: 0.0005 })

  // Index every letter across all lines (spaces keep their slot).
  const text = lines.join('\n')
  const N = text.length
  const paint = (v: number) => {
    const span = 18 // letters in flight at once
    const head = Math.min(1, Math.max(0, (v - 0.04) / 0.86)) * (N + span)
    for (let i = 0; i < N; i++) {
      const el = chars.current[i]
      if (!el) continue
      const local = Math.max(0, Math.min(1, (head - i) / span))
      const real = el.dataset.c!
      el.style.opacity = String(0.1 + local * 0.9)
      el.style.filter = local >= 1 ? 'none' : `blur(${(1 - local) * 6}px)`
      el.style.transform = local >= 1 ? 'none' : `translateY(${(1 - local) * 0.25}em)`
      // In flight: flicker through noise, then settle on the real letter.
      const flying = local > 0.05 && local < 0.75 && real.trim()
      const shown = flying ? NOISE[(i * 7 + Math.floor(v * 900)) % NOISE.length] : real
      if (el.textContent !== shown) el.textContent = shown
      el.classList.toggle('is-hot', !!flying)
    }
  }
  // The counter tracks the writing (same window as `paint`), so it reads 100
  // exactly when the last letter settles.
  const meter = (v: number) => {
    const c = Math.min(1, Math.max(0, (v - 0.04) / 0.86))
    if (counter.current) counter.current.textContent = String(Math.round(c * 100)).padStart(3, '0')
    if (bar.current) bar.current.style.transform = `scaleX(${c})`
  }
  useMotionValueEvent(p, 'change', (v) => { if (!reduced) paint(v) })
  useMotionValueEvent(scrollYProgress, 'change', (v) => { if (!reduced) meter(v) })
  useEffect(() => { paint(reduced ? 1 : p.get()); meter(reduced ? 1 : scrollYProgress.get()) }, [reduced])

  let k = 0
  return (
    <div ref={ref} className="manifesto" style={{ height: reduced ? 'auto' : `${Math.max(220, lines.length * 70)}vh` }}>
      <div className="manifesto__pin">
        <div className="manifesto__meta" aria-hidden="true">
          <span className="kicker">{kicker}</span>
          <span className="manifesto__count"><span ref={counter}>000</span><small>/100</small></span>
          <span className="manifesto__track"><span ref={bar} className="manifesto__bar" /></span>
        </div>
        <p className="manifesto__text" aria-label={lines.join(' ')}>
          {lines.map((line, li) => (
            <span key={li} className="manifesto__line" aria-hidden="true">
              {line.split(' ').map((word, wi, arr) => {
                const word$ = (
                  <span key={wi} className="manifesto__word">
                    {word.split('').map((c) => {
                      const i = k++
                      return <span key={i} ref={(el) => { chars.current[i] = el }} data-c={c} className="manifesto__ch">{c}</span>
                    })}
                  </span>
                )
                if (wi < arr.length - 1) { const i = k++; return [word$, <span key={`s${wi}`} ref={(el) => { chars.current[i] = el }} data-c=" " className="manifesto__sp"> </span>] }
                return word$
              })}
              {(() => { k++; return null })()}
            </span>
          ))}
        </p>
      </div>
    </div>
  )
}

/**
 * Heading that rises into view word by word from behind a clip line, once,
 * when it scrolls in. Screen readers get the plain text.
 */
export function RevealHeading({ text, as: Tag = 'h2', className = '' }: { text: string; as?: ElementType; className?: string }) {
  const ref = useRef<HTMLHeadingElement>(null)
  const reduced = useReduced()
  const inView = useInView(ref, { once: true, margin: '0px 0px -12% 0px' })
  const show = reduced || inView
  const words = text.split(' ')
  return (
    <Tag ref={ref} className={`reveal ${className}`} aria-label={text}>
      {words.map((w, i) => (
        <span key={i} className="reveal__mask" aria-hidden="true">
          <motion.span
            className="reveal__word"
            initial={reduced ? false : { y: '110%', rotate: 4 }}
            animate={show ? { y: '0%', rotate: 0 } : { y: '110%', rotate: 4 }}
            transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1], delay: i * 0.055 }}
          >
            {w}
          </motion.span>
        </span>
      ))}
    </Tag>
  )
}
