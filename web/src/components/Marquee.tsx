import { useRef } from 'react'
import { motion, useAnimationFrame, useMotionValue, useScroll, useSpring, useTransform, useVelocity } from 'motion/react'
import { useReduced } from '../lib/useReduced'

/*
 * Endless ticker. Base drift plus scroll velocity: scrolling fast speeds it up,
 * flips its direction with the scroll, and skews the band.
 */
export default function Marquee({ items }: { items: string[] }) {
  const reduced = useReduced()
  const x = useMotionValue(0)
  const dir = useRef(1)
  const { scrollY } = useScroll()
  const vel = useSpring(useVelocity(scrollY), { damping: 50, stiffness: 400 })
  const boost = useTransform(vel, [-2000, 0, 2000], [-6, 0, 6], { clamp: false })
  const skew = useTransform(vel, [-3000, 3000], [8, -8])
  const wrapRef = useRef<HTMLDivElement>(null)

  useAnimationFrame((_, delta) => {
    if (reduced) return
    const b = boost.get()
    if (b < 0) dir.current = -1
    else if (b > 0) dir.current = 1
    const half = (wrapRef.current?.scrollWidth ?? 2) / 2
    let next = x.get() - dir.current * (delta / 1000) * 60 * (1 + Math.abs(b))
    if (next <= -half) next += half
    if (next > 0) next -= half
    x.set(next)
  })

  const line = items.map((t) => (
    <span key={t} className="marq__item">{t}<b aria-hidden="true">▓▒░</b></span>
  ))
  return (
    <div className="marq" aria-label={items.join(', ')}>
      <motion.div ref={wrapRef} className="marq__track" style={{ x, skewX: reduced ? 0 : skew }} aria-hidden="true">
        {line}{line}
      </motion.div>
    </div>
  )
}
