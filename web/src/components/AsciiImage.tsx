import { useEffect, useRef } from 'react'
import { useCanvasLoop } from '../lib/useCanvasLoop'
import { BINARY, MONO, NOISE, pick, rampAt } from '../lib/glyphs'
import { useReduced } from '../lib/useReduced'

/*
 * Renders an image (or a word) as live ASCII.
 *
 * The source is cropped to its lit pixels, drawn once into a tiny canvas of
 * cols × rows (the browser does the averaging), and each cell keeps its target
 * glyph. On top of that target: an intro decode (noise until each cell locks),
 * pointer scatter (cells near the cursor flicker and get pushed away on a
 * spring), a periodic binary scan line, and rare idle glitches.
 */
export type AsciiSource = { kind: 'image'; src: string } | { kind: 'text'; text: string; weight?: number }

type Cell = {
  lum: number
  target: string
  lockAt: number
  ox: number
  oy: number
  vx: number
  vy: number
  glitchUntil: number
  glyph: string
}

export default function AsciiImage({
  source,
  cell = 10,
  ink = '#f2f2f2',
  accent = '#ffffff',
  scatter = 90,
  scan = true,
  minCols = 0,
  className,
  label,
}: {
  source: AsciiSource
  /** Row height in CSS px; columns are 0.6 of that. */
  cell?: number
  ink?: string
  accent?: string
  /** Pointer radius in CSS px. 0 disables the scatter. */
  scatter?: number
  scan?: boolean
  /** Shrink the cell on narrow boxes so the art keeps at least this many columns. */
  minCols?: number
  className?: string
  label: string
}) {
  const reduced = useReduced()
  const bitmap = useRef<HTMLCanvasElement | null>(null)
  const grid = useRef<{ cols: number; rows: number; cells: Cell[]; x0: number; y0: number; cw: number; ch: number; born: number } | null>(null)
  const size = useRef({ w: 0, h: 0 })

  // Build a cropped grayscale bitmap of the source once.
  useEffect(() => {
    let cancelled = false
    const make = async () => {
      let src: CanvasImageSource, sw: number, sh: number
      if (source.kind === 'image') {
        const img = new Image()
        img.src = source.src
        await img.decode()
        src = img; sw = img.naturalWidth; sh = img.naturalHeight
      } else {
        await document.fonts.load(`${source.weight ?? 900} 200px Archivo`)
        const c = document.createElement('canvas')
        const ctx = c.getContext('2d')!
        ctx.font = `${source.weight ?? 900} 200px Archivo`
        sw = Math.ceil(ctx.measureText(source.text).width) + 40; sh = 240
        c.width = sw; c.height = sh
        ctx.font = `${source.weight ?? 900} 200px Archivo`
        // A diagonal gradient instead of flat white, so the ramp has range to show.
        const grad = ctx.createLinearGradient(0, 0, sw, sh)
        grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.55, '#9a9a9a'); grad.addColorStop(1, '#3c3c3c')
        ctx.fillStyle = grad
        ctx.textBaseline = 'middle'
        ctx.fillText(source.text, 20, sh / 2 + 8)
        src = c
      }
      bitmap.current = crop(src, sw, sh)
      if (!cancelled) rebuild()
    }
    make()
    return () => { cancelled = true }
  }, [source.kind === 'image' ? source.src : source.text])

  const rebuild = () => {
    const bmp = bitmap.current
    const { w, h } = size.current
    if (!bmp || !w || !h) return
    const ch = minCols ? Math.max(4, Math.min(cell, w / (minCols * 0.6))) : cell
    const cw = ch * 0.6
    // Fit the bitmap inside the box, accounting for non-square cells.
    const scale = Math.min(w / bmp.width, h / bmp.height)
    const cols = Math.max(1, Math.floor((bmp.width * scale) / cw))
    const rows = Math.max(1, Math.floor((bmp.height * scale) / ch))
    const s = document.createElement('canvas')
    s.width = cols; s.height = rows
    const sctx = s.getContext('2d', { willReadFrequently: true })!
    sctx.imageSmoothingQuality = 'high'
    sctx.drawImage(bmp, 0, 0, cols, rows)
    const data = sctx.getImageData(0, 0, cols, rows).data
    const cells: Cell[] = []
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = (j * cols + i) * 4
        const lum = (0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2]) / 255
        const target = lum < 0.06 ? ' ' : rampAt(Math.pow(lum, 0.8))
        cells.push({
          lum, target, glyph: target,
          lockAt: 0.15 + (i / cols) * 1.1 + Math.random() * 0.55,
          ox: 0, oy: 0, vx: 0, vy: 0, glitchUntil: 0,
        })
      }
    grid.current = {
      cols, rows, cells, cw, ch,
      x0: (w - cols * cw) / 2, y0: (h - rows * ch) / 2,
      born: -1,
    }
  }

  const ref = useCanvasLoop(
    ({ ctx, w, h, t, dt, pointer }) => {
      ctx.clearRect(0, 0, w, h)
      const g = grid.current
      if (!g) return
      if (g.born < 0) g.born = t
      const age = reduced ? 99 : t - g.born
      const scanY = scan && !reduced ? ((t % 7) / 7) * (g.rows + 24) - 12 : -999

      ctx.font = `500 ${g.ch * 0.95}px ${MONO}`
      ctx.textBaseline = 'top'
      const k = 1 - Math.exp(-dt * 9)

      for (let j = 0; j < g.rows; j++) {
        const inScan = Math.abs(j - scanY) < 1.5
        for (let i = 0; i < g.cols; i++) {
          const c = g.cells[j * g.cols + i]
          if (c.target === ' ' && !inScan) continue
          let x = g.x0 + i * g.cw
          let y = g.y0 + j * g.ch
          let glyph = c.target
          let alpha = 0.25 + c.lum * 0.75
          let hot = false

          if (age < c.lockAt) {
            if (age < c.lockAt - 0.6) continue
            glyph = pick(NOISE)
            alpha = 0.5
          } else if (scatter > 0 && pointer.active) {
            const dx = x - pointer.x, dy = y - pointer.y
            const d = Math.hypot(dx, dy)
            if (d < scatter) {
              const f = 1 - d / scatter
              c.vx += (dx / (d || 1)) * f * 900 * dt
              c.vy += (dy / (d || 1)) * f * 900 * dt
              if (Math.random() < f * 0.5) c.glyph = c.target === ' ' ? pick('.:') : pick(NOISE)
              hot = f > 0.35
            }
          }

          // Spring back home.
          c.vx += -c.ox * 60 * dt; c.vy += -c.oy * 60 * dt
          c.vx *= 1 - k * 0.9; c.vy *= 1 - k * 0.9
          c.ox += c.vx * dt; c.oy += c.vy * dt
          x += c.ox; y += c.oy

          if (age >= c.lockAt) {
            if (inScan) { glyph = c.lum > 0.06 ? pick(BINARY) : (Math.random() < 0.15 ? pick(BINARY) : ' '); hot = c.lum > 0.06 }
            else if (t < c.glitchUntil) glyph = c.glyph
            else if (Math.abs(c.ox) + Math.abs(c.oy) > 1.5) glyph = c.glyph
            else if (!reduced && Math.random() < 0.0004) { c.glitchUntil = t + 0.12; c.glyph = pick(NOISE); glyph = c.glyph }
            else c.glyph = c.target
          }
          if (glyph === ' ') continue
          ctx.globalAlpha = hot ? 1 : alpha
          ctx.fillStyle = hot ? accent : ink
          ctx.fillText(glyph, x, y)
        }
      }
      ctx.globalAlpha = 1
    },
    {
      maxDpr: 2,
      paused: reduced,
      onResize: (w, h) => { size.current = { w, h }; rebuild() },
    },
  )

  return <canvas ref={ref} role="img" aria-label={label} className={className} />
}

/* Trim the dark margin so the art fills its box; returns a grayscale copy. */
function crop(src: CanvasImageSource, sw: number, sh: number) {
  const c = document.createElement('canvas')
  c.width = sw; c.height = sh
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(src, 0, 0)
  const d = ctx.getImageData(0, 0, sw, sh).data
  let x0 = sw, y0 = sh, x1 = 0, y1 = 0
  for (let y = 0; y < sh; y += 2)
    for (let x = 0; x < sw; x += 2) {
      const k = (y * sw + x) * 4
      if (d[k] + d[k + 1] + d[k + 2] > 120) {
        if (x < x0) x0 = x; if (x > x1) x1 = x
        if (y < y0) y0 = y; if (y > y1) y1 = y
      }
    }
  if (x1 <= x0 || y1 <= y0) return c
  const pad = 6
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad)
  x1 = Math.min(sw, x1 + pad); y1 = Math.min(sh, y1 + pad)
  const out = document.createElement('canvas')
  out.width = x1 - x0; out.height = y1 - y0
  out.getContext('2d')!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height)
  return out
}
