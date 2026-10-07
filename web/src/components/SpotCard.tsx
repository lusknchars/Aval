import { useRef, type ReactNode } from 'react'
import { motion, useMotionTemplate, useMotionValue, useSpring } from 'motion/react'
import { useReduced } from '../lib/useReduced'

/*
 * Card with a pointer-following spotlight on its border and a light 3D tilt.
 * The glow is a masked radial gradient on a pseudo layer, so the content
 * never repaints while the pointer moves.
 */
export default function SpotCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  const reduced = useReduced()
  const el = useRef<HTMLDivElement>(null)
  const mx = useMotionValue(-200), my = useMotionValue(-200)
  const rx = useSpring(0, { stiffness: 200, damping: 20 })
  const ry = useSpring(0, { stiffness: 200, damping: 20 })
  const glow = useMotionTemplate`radial-gradient(260px circle at ${mx}px ${my}px, rgba(var(--glow-rgb),.55), transparent 60%)`
  const wash = useMotionTemplate`radial-gradient(420px circle at ${mx}px ${my}px, rgba(var(--glow-rgb),.06), transparent 65%)`

  return (
    <motion.div
      ref={el}
      className={`spot ${className}`}
      style={reduced ? undefined : { rotateX: rx, rotateY: ry, transformPerspective: 900 }}
      onPointerMove={(e) => {
        const r = el.current!.getBoundingClientRect()
        const x = e.clientX - r.left, y = e.clientY - r.top
        mx.set(x); my.set(y)
        if (!reduced) { ry.set((x / r.width - 0.5) * 8); rx.set(-(y / r.height - 0.5) * 8) }
      }}
      onPointerLeave={() => { mx.set(-400); my.set(-400); rx.set(0); ry.set(0) }}
    >
      <motion.span className="spot__ring" style={{ background: glow }} aria-hidden="true" />
      <motion.span className="spot__wash" style={{ background: wash }} aria-hidden="true" />
      <div className="spot__body">{children}</div>
    </motion.div>
  )
}
