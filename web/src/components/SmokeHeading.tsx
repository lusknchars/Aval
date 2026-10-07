import { lazy, Suspense, useRef } from 'react'
import { useInView } from 'motion/react'

// three.js loads when the heading is about a screen away, not with the page.
const Impl = lazy(() => import('./SmokeHeadingImpl'))

/* Until the smoke loads, the same heading renders plainly at the same size. */
export default function SmokeHeading({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const near = useInView(ref, { once: true, margin: '100% 0px 100% 0px' })
  const plain = <h2 className="smoke-h smoke-h--static">{text}</h2>
  return (
    <div ref={ref}>
      {near ? <Suspense fallback={plain}><Impl text={text} /></Suspense> : plain}
    </div>
  )
}
