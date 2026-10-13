import { lazy, Suspense, useRef } from 'react'
import { useInView } from 'motion/react'

// three.js comes in when the reel is about a screen away.
const Impl = lazy(() => import('./AttackReelImpl'))

export default function AttackReel() {
  const ref = useRef<HTMLDivElement>(null)
  const near = useInView(ref, { once: true, margin: '100% 0px 100% 0px' })
  const placeholder = <div className="attacks__reel attacks__reel--loading" />
  return <div ref={ref}>{near ? <Suspense fallback={placeholder}><Impl /></Suspense> : placeholder}</div>
}
