import { AnimatePresence, motion } from 'motion/react'
import { useRoute } from './router'
import { useEngine } from './api/engine'
import Overview from './pages/Overview'
import Evaluate from './pages/Evaluate'
import Actions from './pages/Actions'
import TraceView from './pages/TraceView'
import Review from './pages/Review'
import CommandPalette from './ui/CommandPalette'
import Toasts from './ui/Toasts'
import Scramble from '../components/Scramble'
import { useReduced } from '../lib/useReduced'

const NAV = [
  { k: 'overview', label: 'Overview', g: '◇' },
  { k: 'evaluate', label: 'Evaluate', g: '▷' },
  { k: 'actions', label: 'Actions', g: '≡' },
  { k: 'review', label: 'Review', g: '◎' },
]

export default function App() {
  const route = useRoute()
  const engine = useEngine()
  const reduced = useReduced()
  const [page = 'overview', arg] = route
  const key = route.join('/') || 'overview'

  let view
  if (page === 'evaluate') view = <Evaluate preset={arg} />
  else if (page === 'actions' && arg) view = <TraceView id={arg} />
  else if (page === 'actions') view = <Actions />
  else if (page === 'review') view = <Review />
  else view = <Overview />

  return (
    <div className="shell">
      <a href="#main" className="skip">Skip to content</a>
      <aside className="rail">
        <a className="rail__brand" href="/" aria-label="AVAL site">
          <span className="rail__mark" aria-hidden="true" />
          <span>AVAL<em>console</em></span>
        </a>
        <nav className="rail__nav" aria-label="Console">
          {NAV.map((n) => {
            const on = page === n.k
            return (
              <a key={n.k} href={`#/${n.k}`} className={on ? 'is-on' : ''} aria-current={on ? 'page' : undefined}>
                {on && <motion.span layoutId="rail-hl" className="rail__hl" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                <span className="rail__g" aria-hidden="true">{n.g}</span>
                <Scramble text={n.label} />
              </a>
            )
          })}
        </nav>
        <button type="button" className="rail__k" onClick={() => dispatchEvent(new Event('aval:palette'))}>
          <span>Search</span><kbd>⌘K</kbd>
        </button>
        <div className={`rail__engine engine engine--${engine}`}>
          <i aria-hidden="true" />
          <span>
            {engine === 'live' ? 'engine live' : engine === 'offline' ? 'engine offline' : 'checking…'}
            <small>{engine === 'offline' ? 'showing recorded verdicts' : 'veto demo · /veto'}</small>
          </span>
        </div>
      </aside>

      <main id="main" className="main">
        <AnimatePresence mode="wait">
          <motion.div
            key={key}
            initial={reduced ? false : { opacity: 0, y: 10, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={reduced ? undefined : { opacity: 0, y: -6, filter: 'blur(4px)', transition: { duration: 0.15 } }}
            transition={{ type: 'spring', stiffness: 260, damping: 30 }}
          >
            {view}
          </motion.div>
        </AnimatePresence>
      </main>
      <CommandPalette />
      <Toasts />
    </div>
  )
}
