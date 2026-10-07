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
      colors={light ? ['#0d0d0c', '#3a3a38'] : ['#e3fff3', '#eeeded']}
      lineCount={24}
      speed={0.6}
      quality={0.75}
      centerY={centerY}
    />
  )
}
