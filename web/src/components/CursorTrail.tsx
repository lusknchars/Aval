import { useEffect, useRef } from 'react'
import { MONO, NOISE, pick } from '../lib/glyphs'
import { useReduced } from '../lib/useReduced'
import { palette } from '../lib/theme'

/*
 * Page-wide glyph trail: every ~14px of pointer travel drops a character that
 * drifts, cools from white to grey and fades. Fine pointers only, so touch
 * screens never pay for it.
 */
export default function CursorTrail() {
  const ref = useRef<HTMLCanvasElement>(null)
  const reduced = useReduced()

  useEffect(() => {
    if (reduced || !matchMedia('(pointer: fine)').matches) return
    const c = ref.current!
    const ctx = c.getContext('2d')!
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const fit = () => { c.width = innerWidth * dpr; c.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0) }
    fit()
    addEventListener('resize', fit)
    type P = { x: number; y: number; vx: number; vy: number; life: number; ch: string }
    const ps: P[] = []
    let lx = -1, ly = -1, raf = 0, last = performance.now()
    const move = (e: PointerEvent) => {
      if (lx < 0) { lx = e.clientX; ly = e.clientY }
      const d = Math.hypot(e.clientX - lx, e.clientY - ly)
      for (let s = 14; s <= d; s += 14) {
        const k = s / d
        ps.push({
          x: lx + (e.clientX - lx) * k, y: ly + (e.clientY - ly) * k,
          vx: (Math.random() - 0.5) * 30, vy: 20 + Math.random() * 30, life: 1, ch: pick(NOISE),
        })
      }
      if (d >= 14) { lx = e.clientX; ly = e.clientY }
      if (ps.length > 120) ps.splice(0, ps.length - 120)
    }
    addEventListener('pointermove', move, { passive: true })
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(0.05, (now - last) / 1000); last = now
      ctx.clearRect(0, 0, innerWidth, innerHeight)
      ctx.font = `500 13px ${MONO}`
      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i]
        p.life -= dt * 1.6
        if (p.life <= 0) { ps.splice(i, 1); continue }
        p.x += p.vx * dt; p.y += p.vy * dt
        if (Math.random() < 0.08) p.ch = pick(NOISE)
        ctx.fillStyle = `rgba(${palette.ink},${(p.life * 0.9).toFixed(3)})`
        ctx.fillText(p.ch, p.x, p.y)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); removeEventListener('pointermove', move); removeEventListener('resize', fit) }
  }, [reduced])

  return <canvas ref={ref} className="trail" aria-hidden="true" />
}
