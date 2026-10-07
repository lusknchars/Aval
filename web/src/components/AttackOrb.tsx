import { lazy, Suspense, useRef } from 'react'
import { useInView } from 'motion/react'

// Shares the three.js chunk; loads about a screen before the attacks section.
const Impl = lazy(() => import('./AttackOrbImpl'))

/* The glyph globe above the attack reel. */
export default function AttackOrb() {
  const ref = useRef<HTMLDivElement>(null)
  const near = useInView(ref, { once: true, margin: '100% 0px 100% 0px' })
  return (
    <div ref={ref} className="attacks__orb" aria-hidden="true">
      {near && <Suspense fallback={null}><Impl /></Suspense>}
    </div>
  )
}
