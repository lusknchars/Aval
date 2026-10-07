import SmokeType from '@/components/ui/smoke-type'
import { useTheme } from '../lib/theme'

/* AVAL's heading type, condensing out of theme-matched smoke. */
export default function SmokeHeadingImpl({ text }: { text: string }) {
  const dark = useTheme() === 'dark'
  return (
    <SmokeType
      as="h2"
      text={text}
      className="smoke-h"
      fontSize="clamp(34px, 5vw, 64px)"
      fontWeight={700}
      letterSpacing="-0.015em"
      lineHeight={1}
      align="left"
      color={dark ? '#ececec' : '#0d0d0c'}
      smokeColor={dark ? '#8a8a93' : '#5d5d58'}
      direction="left"
      duration={1.1}
      stagger={0.045}
      rise={1.1}
      turbulence={1.2}
      replayOnHover
    />
  )
}
