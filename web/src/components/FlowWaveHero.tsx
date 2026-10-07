import { lazy, Suspense, useRef, type ReactNode } from 'react'
import { useScroll } from 'motion/react'

// three.js is fetched right away (this is the first screen), in its own chunk.
const Impl = lazy(() => import('./FlowWaveImpl'))

/*
 * Lookbook-style hero: the Flow Wave field fills the top of a pinned stage
 * and the copy sits in a band beneath it. The wrapper is taller than the
 * screen, so scrolling through it drives the camera dive before the page
 * moves on.
 */
export default function FlowWaveHero({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] })
  return (
    <section ref={ref} className="wave" id="home">
      <div className="wave__stage">
        <div className="wave__field">
          <Suspense fallback={null}><Impl progress={scrollYProgress} /></Suspense>
        </div>
        {children}
      </div>
    </section>
  )
}
