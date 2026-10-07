import { lazy, Suspense, useRef, type ReactNode } from 'react'
import { useInView } from 'motion/react'

// three.js loads about a screen before the band scrolls in.
const Impl = lazy(() => import('./CurrentBandImpl'))

/*
 * One continuous ChromaCurrent behind several sections. The content sits on
 * top but lets the pointer through its empty areas, so moving and clicking
 * the background stirs the current and drops plumes; cards, buttons and links
 * keep working normally.
 */
export default function CurrentBand({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const near = useInView(ref, { once: true, margin: '100% 0px 100% 0px' })
  return (
    <div ref={ref} className="band">
      <div className="band__bg" aria-hidden="true">
        {near && <Suspense fallback={null}><Impl /></Suspense>}
        <span className="band__veil" />
      </div>
      <div className="band__content">{children}</div>
    </div>
  )
}
