import { useEffect, useState } from 'react'
import { useReduced } from '../lib/useReduced'

/* Cycles through hand-drawn ASCII frames. Reduced motion holds the last one. */
export default function FrameLoop({ frames, ms = 160, className }: { frames: string[]; ms?: number; className?: string }) {
  const reduced = useReduced()
  const [i, setI] = useState(0)
  useEffect(() => {
    if (reduced) return setI(frames.length - 1)
    const t = setInterval(() => setI((x) => (x + 1) % frames.length), ms)
    return () => clearInterval(t)
  }, [reduced, frames.length, ms])
  return <pre className={className} aria-hidden="true">{frames[i]}</pre>
}
