import { lazy, Suspense, useRef } from 'react'
import { useInView } from 'motion/react'

// three.js + the 55 KB model load about a screen before the band.
const Impl = lazy(() => import('./SolanaFloatImpl'))

/* Floating black Solana mark in the verdicts band, with the model's credit. */
export default function SolanaFloat() {
  const ref = useRef<HTMLDivElement>(null)
  const near = useInView(ref, { once: true, margin: '100% 0px 100% 0px' })
  return (
    <div ref={ref} className="solfloat">
      <div className="solfloat__stage" aria-hidden="true">{near && <Suspense fallback={null}><Impl /></Suspense>}</div>
      <a className="solfloat__credit" href="https://sketchfab.com/3d-models/solana-logo-7b786b250ea74f0bbb007b1b99792745" target="_blank" rel="noreferrer">
        3D model “Solana Logo” by eshraqism · CC BY 4.0
      </a>
    </div>
  )
}
