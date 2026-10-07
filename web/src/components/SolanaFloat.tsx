import { lazy, Suspense, useRef } from 'react'
import { useInView } from 'motion/react'

// three.js + the 55 KB model load about a screen before the band.
const Impl = lazy(() => import('./SolanaFloatImpl'))

/* Floating black Solana mark in the verdicts band (model credit: footer). */
export default function SolanaFloat() {
  const ref = useRef<HTMLDivElement>(null)
  const near = useInView(ref, { once: true, margin: '100% 0px 100% 0px' })
  return (
    <div ref={ref} className="solfloat">
      <div className="solfloat__stage" aria-hidden="true">{near && <Suspense fallback={null}><Impl /></Suspense>}</div>
    </div>
  )
}
