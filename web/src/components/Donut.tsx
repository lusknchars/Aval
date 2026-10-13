import { useEffect, useRef } from 'react'
import { useReduced } from '../lib/useReduced'

/*
 * The classic donut.c torus, rendered into a <pre>. Luminance comes from the
 * surface normal against a fixed light; a z-buffer keeps the nearest point.
 * Writing textContent directly skips React for the 30 fps loop.
 */
const W = 44, H = 22, L = '.,-~:;=!*#$@'

export default function Donut({ className }: { className?: string }) {
  const pre = useRef<HTMLPreElement>(null)
  const reduced = useReduced()

  useEffect(() => {
    let A = 1, B = 1, raf = 0, last = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (now - last < 33) return
      last = now
      const out = new Array(W * H).fill(' ')
      const z = new Array(W * H).fill(0)
      const cA = Math.cos(A), sA = Math.sin(A), cB = Math.cos(B), sB = Math.sin(B)
      for (let j = 0; j < 6.28; j += 0.07) {
        const ct = Math.cos(j), st = Math.sin(j)
        for (let i = 0; i < 6.28; i += 0.02) {
          const sp = Math.sin(i), cp = Math.cos(i)
          const h = ct + 2
          const D = 1 / (sp * h * sA + st * cA + 5)
          const t = sp * h * cA - st * sA
          const x = (W / 2 + 20 * D * (cp * h * cB - t * sB)) | 0
          const y = (H / 2 + 10 * D * (cp * h * sB + t * cB)) | 0
          const o = x + W * y
          const N = (8 * ((st * sA - sp * ct * cA) * cB - sp * ct * sA - st * cA - cp * ct * sB)) | 0
          if (y >= 0 && y < H && x >= 0 && x < W && D > z[o]) {
            z[o] = D
            out[o] = L[N > 0 ? N : 0]
          }
        }
      }
      let s = ''
      for (let k = 0; k < H; k++) s += out.slice(k * W, k * W + W).join('') + '\n'
      if (pre.current) pre.current.textContent = s
      A += 0.05; B += 0.025
      if (reduced) cancelAnimationFrame(raf)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [reduced])

  return <pre ref={pre} className={className} aria-hidden="true" />
}
