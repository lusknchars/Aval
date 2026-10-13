import { useRef, useState } from 'react'
import { motion } from 'motion/react'
import { NOISE, pick } from '../lib/glyphs'
import { useReduced } from '../lib/useReduced'

/*
 * Primary action. On hover a solid fill wipes in from the left behind the
 * label, the label scrambles and settles in inverted ink, and the bracket
 * corners breathe outward. The arrow is a glyph, so it scrambles too.
 */
export default function ScrambleButton({
  label,
  href,
  variant = 'solid',
}: {
  label: string
  href: string
  variant?: 'solid' | 'ghost'
}) {
  const reduced = useReduced()
  const [txt, setTxt] = useState(label)
  const t = useRef<number>(0)

  const go = () => {
    if (reduced) return
    clearInterval(t.current)
    let f = 0
    t.current = window.setInterval(() => {
      f++
      setTxt(label.split('').map((c, i) => (c === ' ' || f > i * 1.5 ? c : pick(NOISE))).join(''))
      if (f > label.length * 1.5) { clearInterval(t.current); setTxt(label) }
    }, 30)
  }

  return (
    <motion.a
      href={href}
      className={`sbtn sbtn--${variant}`}
      onMouseEnter={go}
      onFocus={go}
      whileTap={reduced ? undefined : { scale: 0.97 }}
      aria-label={label}
    >
      <span className="sbtn__fill" aria-hidden="true" />
      <span className="sbtn__corner sbtn__corner--tl" aria-hidden="true" />
      <span className="sbtn__corner sbtn__corner--br" aria-hidden="true" />
      <span className="sbtn__label" aria-hidden="true">{txt}</span>
      <span className="sbtn__arrow" aria-hidden="true">-&gt;</span>
    </motion.a>
  )
}
