import { lazy, Suspense, useRef, type ReactNode } from 'react'
import { useInView } from 'motion/react'

// Shares the three.js chunk; loads about a screen before the section.
const Impl = lazy(() => import('./KnotBandImpl'))

/*
 * The Photon Knot behind the receipts section, full bleed, fading into the
 * page at top and bottom. Empty areas of the section let the pointer through
 * so the knot still responds; the receipt card and the copy stay interactive.
 */
export default function KnotBand({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const near = useInView(ref, { once: true, margin: '100% 0px 100% 0px' })
  return (
    <div ref={ref} className="knotband">
      <div className="knotband__bg" aria-hidden="true">
        {near && <Suspense fallback={null}><Impl /></Suspense>}
        <span className="knotband__veil" />
      </div>
      <div className="knotband__content">{children}</div>
    </div>
  )
}
