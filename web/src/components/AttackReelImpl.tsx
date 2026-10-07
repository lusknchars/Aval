import { useEffect, useState } from 'react'
import ElasticReel, { type ElasticReelItem } from '@/components/ui/elastic-reel'
import { useTheme } from '../lib/theme'
import { ATTACKS, poster } from './attacks'

/* The reel, with one generated poster per attack, redrawn for the theme. */
export default function AttackReelImpl() {
  const dark = useTheme() === 'dark'
  const [items, setItems] = useState<ElasticReelItem[] | null>(null)
  useEffect(() => {
    let live = true
    Promise.all([
      document.fonts.load('700 100px "Chakra Petch"'),
      document.fonts.load('500 20px "JetBrains Mono"'),
    ]).catch(() => {}).then(() => {
      if (!live) return
      setItems(ATTACKS.map((a, i) => ({
        src: poster(a, i, dark),
        alt: `${a.title}: ${a.what}`,
        title: a.title,
        subtitle: `${a.verdict === 'DENY' ? 'Denied' : 'Held'} · ${a.rule}`,
      })))
    })
    return () => { live = false }
  }, [dark])
  if (!items) return <div className="attacks__reel attacks__reel--loading" />
  return (
    <ElasticReel
      className="attacks__reel"
      items={items}
      barWidth={64}
      barHeight={0.56}
      gap={10}
      radius={10}
      magnify={2.2}
      lift={1.2}
      openSize={0.74}
      openAspect={1}
      autoplay="sweep"
      speed={1.1}
      wheel={false}
      ariaLabel="Attacks AVAL stops. Hover or use the arrow keys to browse, click an attack to open it."
    />
  )
}
