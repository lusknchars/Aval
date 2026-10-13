import { forwardRef } from 'react'
import InterferenceRibbons, { type InterferenceRibbonsHandle } from '@/components/ui/interference-ribbons'
import { useTheme } from '../lib/theme'

/* Monochrome ribbons behind the manifesto, matched to the page theme.
   Loaded lazily (three.js) by ScrollManifesto. */
const ManifestoRibbons = forwardRef<InterferenceRibbonsHandle>(function ManifestoRibbons(_, ref) {
  const theme = useTheme()
  const dark = theme === 'dark'
  return (
    <InterferenceRibbons
      ref={ref}
      className="manifesto__ribbons"
      backgroundColor={dark ? '#050505' : '#f2f2ef'}
      colors={dark ? ['#4a4a55', '#eeeef2'] : ['#141414', '#8c8c86']}
      mode="auto"
      wires={72}
      angle={-16}
      amplitude={0.55}
      ribbonWidth={0.3}
      twist={1.8}
      intensity={dark ? 0.85 : 0.9}
      glow={0.5}
      speed={0.55}
      quality={0.85}
    />
  )
})
export default ManifestoRibbons
