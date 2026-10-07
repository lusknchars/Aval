import { useEffect, useRef, useState } from 'react'
import { MONO, NOISE, rampAt } from '../lib/glyphs'
import { current } from '../lib/theme'

/*
 * Load sequence, once per page load (~3.3 s, any click or key skips ahead):
 *   1. construct  the AVAL mark assembles as ASCII, top to bottom, each cell
 *                 flickering through noise before it settles on its glyph;
 *   2. rebuild    a scan line runs down the mark, re-scrambling and
 *                 re-settling it while the "arming" counter finishes;
 *   3. fill       the ASCII fills in to the solid mark, wiping up from below;
 *   4. expand     the mark turns into a window onto the site and grows,
 *                 pivoting on its most solid point, until it covers the
 *                 screen; then the overlay is gone.
 * Reduced motion: a short fade instead.
 */

const T = { construct: 1300, rebuild: 650, fill: 500, expand: 900 }
const T_REBUILD = T.construct
const T_FILL = T_REBUILD + T.rebuild
const T_EXPAND = T_FILL + T.fill
const T_END = T_EXPAND + T.expand

const COLS = 64
const COLORS = {
  dark: { bg: '#050505', ink: '#ececec', dim: '#4c4c4c', hot: '#ff3b2f', mark: '/brand/aval-mark-dark.svg' },
  light: { bg: '#f2f2ef', ink: '#0d0d0c', dim: '#a3a39d', hot: '#e0261a', mark: '/brand/aval-mark-light.svg' },
}

const easeIn = (t: number) => t * t * t
const clamp01 = (t: number) => Math.max(0, Math.min(1, t))

const loadImg = (src: string) => new Promise<HTMLImageElement>((ok, fail) => {
  const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src
})

/** Glyph value per cell, plus the most solid point (pivot) and its clearance. */
function sample(img: HTMLImageElement, cols: number, rows: number, light: boolean) {
  const c = document.createElement('canvas'); c.width = cols; c.height = rows
  const x = c.getContext('2d', { willReadFrequently: true })!
  x.drawImage(img, 0, 0, cols, rows)
  const d = x.getImageData(0, 0, cols, rows).data
  const vals = new Float32Array(cols * rows)
  for (let i = 0; i < cols * rows; i++) {
    const a = d[i * 4 + 3] / 255
    const lum = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255
    vals[i] = a * (0.35 + 0.65 * (light ? 1 - lum : lum))
  }
  // Pivot: the point deepest inside the shape (multi-source BFS from empty px).
  const N = 160
  const m = document.createElement('canvas'); m.width = N; m.height = N
  const mx = m.getContext('2d', { willReadFrequently: true })!
  mx.drawImage(img, 0, 0, N, N)
  const md = mx.getImageData(0, 0, N, N).data
  const dist = new Int32Array(N * N).fill(-1)
  const q: number[] = []
  for (let i = 0; i < N * N; i++) {
    const px = i % N, py = (i / N) | 0
    if (md[i * 4 + 3] < 128 || px === 0 || py === 0 || px === N - 1 || py === N - 1) { dist[i] = 0; q.push(i) }
  }
  for (let h = 0; h < q.length; h++) {
    const i = q[h], px = i % N, py = (i / N) | 0
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = px + dx, ny = py + dy
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue
      const j = ny * N + nx
      if (dist[j] < 0) { dist[j] = dist[i] + 1; q.push(j) }
    }
  }
  let best = 0
  for (let i = 1; i < N * N; i++) if (dist[i] > dist[best]) best = i
  return { vals, pivot: { x: (best % N + 0.5) / N, y: (((best / N) | 0) + 0.5) / N }, clearance: dist[best] / N }
}

export default function Preloader() {
  const [done, setDone] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const cvs = useRef<HTMLCanvasElement>(null)
  const solid = useRef<HTMLImageElement>(null)
  const label = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const el = root.current!, canvas = cvs.current!, img = solid.current!
    const theme = current()
    const C = COLORS[theme]
    const html = document.documentElement
    html.style.overflow = 'hidden'
    document.getElementById('boot')?.remove()
    let raf = 0, alive = true
    const finish = () => {
      if (!alive) return
      alive = false
      cancelAnimationFrame(raf)
      html.style.overflow = ''
      setDone(true)
    }

    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 450, delay: 250, fill: 'forwards' }).finished.then(finish)
      return () => { alive = false; html.style.overflow = '' }
    }

    let skipAt = Infinity
    const skip = () => { skipAt = Math.min(skipAt, performance.now()) }
    addEventListener('pointerdown', skip)
    addEventListener('keydown', skip)

    ;(async () => {
      let mark: HTMLImageElement
      try {
        const [m] = await Promise.all([
          loadImg(C.mark),
          Promise.race([document.fonts.load(`16px ${MONO}`), new Promise((r) => setTimeout(r, 600))]),
        ])
        mark = m
      } catch { finish(); return }
      if (!alive) return

      const S = Math.round(Math.min(innerWidth * 0.62, innerHeight * 0.56, 460))
      const cellW = S / COLS
      const lineH = cellW * 1.3
      const ROWS = Math.floor(S / lineH)
      const dpr = Math.min(devicePixelRatio || 1, 2)
      canvas.width = S * dpr; canvas.height = S * dpr
      canvas.style.width = canvas.style.height = img.style.width = img.style.height = `${S}px`
      const ctx = canvas.getContext('2d')!
      ctx.scale(dpr, dpr)
      ctx.font = `500 ${cellW / 0.6}px ${MONO}`
      ctx.textBaseline = 'top'
      const { vals, pivot, clearance } = sample(mark, COLS, ROWS, theme === 'light')
      // Each cell's arrival: top to bottom with jitter, so the mark is "built".
      const arrive = new Float32Array(COLS * ROWS)
      for (let i = 0; i < COLS * ROWS; i++) arrive[i] = ((i / COLS) | 0) / ROWS * 0.7 * T.construct + Math.random() * 0.3 * T.construct * 0.8
      const t0 = performance.now()
      let shift = 0 // time pulled forward by a skip

      const frame = (now: number) => {
        if (!alive) return
        if (skipAt < Infinity && shift === 0) {
          const t = now - t0
          if (t < T_EXPAND - 120) shift = T_EXPAND - 120 - t
          else shift = 1
        }
        const t = now - t0 + (shift > 1 ? shift : 0)
        const flick = Math.floor(now / 55)
        // 1 + 2: ASCII construct and rebuild.
        if (t < T_EXPAND) {
          ctx.clearRect(0, 0, S, S)
          const scanY = t >= T_REBUILD ? clamp01((t - T_REBUILD) / T.rebuild) * (ROWS + 6) - 3 : -99
          for (let r = 0; r < ROWS; r++) {
            const nearScan = Math.abs(r - scanY)
            for (let c = 0; c < COLS; c++) {
              const i = r * COLS + c, v = vals[i]
              if (v < 0.04) continue
              const age = t - arrive[i]
              if (age < 0) continue
              let ch: string, col: string
              if (age < 260 || nearScan < 1.5) {
                ch = NOISE[(i * 7 + flick) % NOISE.length]
                col = nearScan < 0.8 ? C.hot : C.dim
              } else { ch = rampAt(v); col = C.ink }
              ctx.fillStyle = col
              ctx.fillText(ch, c * cellW, r * lineH + (S - ROWS * lineH) / 2)
            }
          }
          const pct = Math.round(clamp01(t / T_FILL) * 100)
          if (label.current) label.current.textContent = String(pct).padStart(3, '0')
        }
        // 3: fill, wiping up from the bottom.
        if (t >= T_FILL && t < T_EXPAND) {
          const f = clamp01((t - T_FILL) / T.fill)
          img.style.opacity = '1'
          img.style.clipPath = `inset(${(1 - f) * 100}% 0 0 0)`
          canvas.style.opacity = String(1 - f)
        }
        // 4: expand: the overlay keeps a mark-shaped hole that grows past the screen.
        if (t >= T_EXPAND) {
          const e = easeIn(clamp01((t - T_EXPAND) / T.expand))
          const rect = img.getBoundingClientRect()
          const px = rect.left + pivot.x * S, py = rect.top + pivot.y * S
          const far = Math.max(Math.hypot(px, py), Math.hypot(innerWidth - px, py), Math.hypot(px, innerHeight - py), Math.hypot(innerWidth - px, innerHeight - py))
          const K = (far / Math.max(clearance * S, 4)) * 1.15
          const k = 1 + (K - 1) * e
          const size = S * k
          el.style.setProperty('--hole-size', `${size}px`)
          el.style.setProperty('--hole-x', `${px - pivot.x * size}px`)
          el.style.setProperty('--hole-y', `${py - pivot.y * size}px`)
          el.classList.add('is-open')
          if (t >= T_END) { finish(); return }
        }
        raf = requestAnimationFrame(frame)
      }
      raf = requestAnimationFrame(frame)
    })()

    return () => {
      alive = false
      cancelAnimationFrame(raf)
      html.style.overflow = ''
      removeEventListener('pointerdown', skip)
      removeEventListener('keydown', skip)
    }
  }, [])

  if (done) return null
  const C = COLORS[current()]
  return (
    <div ref={root} className="preload" style={{ background: C.bg, ['--hole' as string]: `url(${C.mark})` }} aria-hidden="true">
      <div className="preload__stage">
        <canvas ref={cvs} className="preload__ascii" />
        <img ref={solid} className="preload__solid" src={C.mark} alt="" />
      </div>
      <p className="preload__label" style={{ color: C.ink }}>
        arming the gate <span ref={label}>000</span><small>%</small>
      </p>
    </div>
  )
}
