import GlyphOrb from '@/components/ui/glyph-orb'
import { useTheme } from '../lib/theme'

/* Glyph Orb with the configuration as supplied; its canvas is opaque, so it
   gets the page colour for the current theme (the component inks itself on
   a light ground). */
export default function AttackOrbImpl() {
  const light = useTheme() === 'light'
  return (
    <GlyphOrb
      className="attacks__orb-gl"
      backgroundColor={light ? '#f2f2ef' : '#050505'}
      colors={['#d9d4ff', '#830004']}
      spacing={0.9}
      spin={1.0500000000000007}
      style={{ minHeight: 0 }}
    />
  )
}
