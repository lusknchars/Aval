import { useEffect, useRef, useState, type ReactNode } from 'react'
import { motion, useScroll, useTransform } from 'motion/react'
import { useReduced } from '../lib/useReduced'

/* Scroll-driven transitions between landing sections. All of them settle into
   a readable resting state, and reduced motion gets that state directly. */

/** Section the header pill should name, by the ids passed in. */
export function useCurrentSection(ids: readonly string[]) {
  const [cur, setCur] = useState(ids[0])
  useEffect(() => {
    const io = new IntersectionObserver((xs) => {
      const v = xs.filter((x) => x.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
      if (v) setCur(v.target.id)
    }, { rootMargin: '-35% 0px -55% 0px', threshold: [0, 0.25, 0.5, 1] })
    ids.forEach((id) => { const el = document.getElementById(id); if (el) io.observe(el) })
    return () => io.disconnect()
  }, [ids.join()])
  return cur
}

export function Rise({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReduced()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'start 0.4'] })
  const y = useTransform(scrollYProgress, [0, 1], [120, 0])
  const r = useTransform(scrollYProgress, [0, 1], [48, 20])
  const s = useTransform(scrollYProgress, [0, 1], [0.94, 1])
  return (
    <motion.div ref={ref} className={className} style={reduced ? undefined : { y, borderTopLeftRadius: r, borderTopRightRadius: r, scale: s }}>
      {children}
    </motion.div>
  )
}
