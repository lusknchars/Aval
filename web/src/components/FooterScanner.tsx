import { lazy, Suspense, useRef } from 'react'
import { useInView } from 'motion/react'

// ogl + the shader load only when the footer is about a screen away.
const Scanner = lazy(() => import('@/components/ui/scanner'))

/* The Scanner background (React Bits) with the configuration as supplied. */
export default function FooterScanner() {
  const ref = useRef<HTMLDivElement>(null)
  const near = useInView(ref, { once: true, margin: '100% 0px 100% 0px' })
  return (
    <div ref={ref} className="finale__scan" aria-hidden="true">
      {near && (
        <Suspense fallback={null}>
          <Scanner
            color1="#cacaca"
            color2="#493f48"
            color3="#FFFFFF"
            speed={1.35}
            sweepSpeed={0.55}
            sweepWidth={0.95}
            sweepFalloff={3.8}
            scale={1.5}
            frequency={1.05}
            ripple={1.15}
            bandDensity={11}
            lineSharpness={5.5}
            glow={0.22}
            scanDirection="vertical"
            colorSpread={0.31}
            brightness={1.95}
            contrast={2.65}
            softness={1.4}
            vignette={0.45}
            scanline={true}
            grain={true}
            grainIntensity={0.05}
            opacity={1.0}
            mouseInteraction={true}
            mouseRadius={0.5}
            mouseStrength={0.5}
          />
        </Suspense>
      )}
    </div>
  )
}
