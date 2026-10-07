import { lazy, Suspense } from 'react'
import { useTheme } from '../lib/theme'

// Shares the three.js chunk with the hero wave.
const MeshLettering = lazy(() => import('@/components/ui/mesh-lettering'))

const LINES = ['Autonomy for your agent.', 'Oversight for your money.']

/*
 * The hero slogan as React Bits Mesh Lettering: each line is cloth in the
 * wind, set in the site's display face. The second line is the dim one, as
 * in every other two-line heading. Plain text shows while three.js loads.
 */
export default function SloganMesh() {
  const light = useTheme() === 'light'
  const palettes: [string, string][] = light
    ? [['#0d0d0c', '#3c3c38'], ['#5d5d58', '#8a8a84']]
    : [['#ffffff', '#c9c9d2'], ['#8a8a94', '#b4b4be']]
  return (
    <h2 className="wave__slogan wave__slogan--mesh" aria-label={LINES.join(' ')}>
      {LINES.map((line, i) => (
        <span key={line} className="wave__mesh-line" aria-hidden="true">
          <Suspense fallback={<span className={`wave__mesh-fallback${i ? ' is-dim' : ''}`}>{line}</span>}>
            <MeshLettering
              text={line}
              fontFamily='"Chakra Petch", system-ui, sans-serif'
              fontWeight={700}
              fontSize={112}
              letterSpacing={-0.01}
              colors={palettes[i]}
              introDuration={1.4 + i * 0.3}
              style={{ minHeight: 0 }}
            />
          </Suspense>
        </span>
      ))}
    </h2>
  )
}
