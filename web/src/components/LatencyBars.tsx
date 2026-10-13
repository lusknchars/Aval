import { useEffect, useRef, useState } from 'react'
import { useInView } from 'motion/react'
import { useReduced } from '../lib/useReduced'

/*
 * Two bars drawn in block glyphs, typed out when in view. Linear scale on
 * purpose: at 0.39 ms against 224 ms, AVAL's bar is a sliver of one cell, and
 * that sliver is the point.
 */
const COLS = 64
const PARTIAL = ' ▏▎▍▌▋▊▉'

function bar(fraction: number) {
  const exact = fraction * COLS
  const full = Math.floor(exact)
  const rest = PARTIAL[Math.round((exact - full) * 7)] ?? ''
  return '█'.repeat(full) + (full < COLS ? rest : '')
}

export default function LatencyBars() {
  const reduced = useReduced()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.5 })
  const [p, setP] = useState(reduced ? 1 : 0)

  useEffect(() => {
    if (!inView || reduced) return
    let raf = 0
    const t0 = performance.now()
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 1800)
      setP(1 - Math.pow(1 - k, 3))
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [inView, reduced])

  const rows = [
    { name: 'aval-svm', ms: 0.39, hot: true },
    { name: 'public rpc', ms: 224, hot: false },
  ]
  return (
    <div ref={ref} className="bars" role="img" aria-label="Simulation latency, warm p50: AVAL 0.39 milliseconds, public RPC 224 milliseconds">
      {rows.map((r) => (
        <div key={r.name} className={`bars__row ${r.hot ? 'is-hot' : ''}`} aria-hidden="true">
          <span className="bars__name">{r.name}</span>
          <span className="bars__track">
            <span className="bars__glyphs">
              {/* Floor AVAL at one partial glyph so it is visible at all. */}
              {bar(Math.max((r.ms / 224) * p, r.hot && p > 0.05 ? 1 / (COLS * 7) : 0))}
              <span className="bars__cursor">{p < 1 ? '▌' : ''}</span>
            </span>
          </span>
          <span className="bars__ms">{(r.ms * p).toFixed(r.ms < 1 ? 2 : 0)}ms</span>
        </div>
      ))}
    </div>
  )
}
