import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { useInView } from 'motion/react'

// three.js loads about a screen before the band scrolls in.
const Impl = lazy(() => import('./CurrentBandImpl'))

/*
 * One continuous ConcentricTides behind several sections. Its horizon of arcs
 * sits on the seam between the first and second section, so it fills the gap
 * between them instead of crossing their text. The content sits on top but
 * lets the pointer through its empty areas, so hovering the background speeds
 * the tides and a click sends a surge; cards, buttons and links keep working.
 */
export default function CurrentBand({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const near = useInView(ref, { once: true, margin: '100% 0px 100% 0px' })
  const [seam, setSeam] = useState(0.5)
  useEffect(() => {
    const el = content.current
    if (!el) return
    const measure = () => {
      const first = el.firstElementChild as HTMLElement | null
      if (first && el.offsetHeight) setSeam(first.offsetHeight / el.offsetHeight)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={ref} className="band">
      <div className="band__bg" aria-hidden="true">
        {near && <Suspense fallback={null}><Impl centerY={seam} /></Suspense>}
        <span className="band__veil" />
      </div>
      <div ref={content} className="band__content">{children}</div>
    </div>
  )
}
