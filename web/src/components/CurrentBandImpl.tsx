import ConcentricTides from '@/components/ui/concentric-tides'
import { useTheme } from '../lib/theme'

/* Concentric tides behind Pipeline + Lifecycle. The canvas is opaque, so its
   background is the page color for the current theme; on the light theme the
   component switches itself to "ink" mode (dark lines on a light page). */
export default function CurrentBandImpl({ centerY }: { centerY: number }) {
  const theme = useTheme()
  const light = theme === 'light'
  return (
    <ConcentricTides
      className="band__current"
      backgroundColor={light ? '#f2f2ef' : '#050505'}
      // Same palette as the manifesto ribbons below, so the two read as one.
      colors={light ? ['#141414', '#8c8c86'] : ['#4a4a55', '#eeeef2']}
      lineCount={24}
      speed={0.6}
      quality={0.75}
      centerY={centerY}
    />
  )
}
