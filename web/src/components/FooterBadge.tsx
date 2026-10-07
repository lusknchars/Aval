import { Component, lazy, Suspense, useRef, type ReactNode } from 'react'
import { useInView } from 'motion/react'

// three-fiber, drei and the rapier physics engine load only near the footer.
const Impl = lazy(() => import('./FooterBadgeImpl'))

/* If the 3D badge fails to load (no WebGL, a network hiccup), drop just the
   badge instead of taking the page down with it. */
class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? null : this.props.children }
}

/* A draggable AVAL agent pass hanging on a lanyard, inside the footer screen. */
export default function FooterBadge() {
  const ref = useRef<HTMLDivElement>(null)
  const near = useInView(ref, { once: true, margin: '100% 0px 100% 0px' })
  return (
    <div ref={ref} className="badge" aria-label="AVAL agent pass on a lanyard; drag it to swing it">
      {near && <Quiet><Suspense fallback={null}><Impl /></Suspense></Quiet>}
    </div>
  )
}
