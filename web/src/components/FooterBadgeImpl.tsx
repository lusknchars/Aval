import { useEffect, useState } from 'react'
import Lanyard from '@/components/ui/lanyard'
import { drawBack, drawFront, drawStrap } from './badgeArt'

type Art = { front: string; back: string; strap: string }

/* The React Bits lanyard, wearing an AVAL transaction security card. */
export default function FooterBadgeImpl() {
  const [art, setArt] = useState<Art | null>(null)
  useEffect(() => {
    let live = true
    Promise.all([drawFront(), drawBack(), drawStrap()]).then(([front, back, strap]) => { if (live) setArt({ front, back, strap }) })
    return () => { live = false }
  }, [])
  if (!art) return null
  return <Lanyard position={[0, 0, 11]} gravity={[0, -40, 0]} frontImage={art.front} backImage={art.back} lanyardImage={art.strap} imageFit="cover" />
}
