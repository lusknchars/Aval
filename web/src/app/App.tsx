import { lazy, Suspense } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useRoute } from './router'
import { useEngine } from './api/engine'
import Overview from './pages/Overview'
import Live from './pages/Live'
import Issues from './pages/Issues'
import Evaluate from './pages/Evaluate'
import Actions from './pages/Actions'
import TraceView from './pages/TraceView'
import Review from './pages/Review'
import Policy from './pages/Policy'
import Manifests from './pages/Manifests'
import Lists from './pages/Lists'
import Agents from './pages/Agents'
import Deploy from './pages/Deploy'
import System from './pages/System'
import Inspect from './pages/Inspect'
import { ChangeBar } from './config/ui'
import { useConfig } from './config/store'
import { diff } from './config/impact'
import { COMPANY } from './config/company'
import CommandPalette from './ui/CommandPalette'
import Toasts from './ui/Toasts'
import Scramble from '../components/Scramble'
import Logo from '../components/Logo'
import ThemeToggle from '../components/ThemeToggle'
import { useReduced } from '../lib/useReduced'
import { DEMO, DEMO_HIDDEN, DOCS_URL, SITE_URL } from './demo'
import { ROTA_RECORDED_ON } from './api/fixtures'

// Monitoring pulls in recharts (~half the console's bundle), so it loads on first visit.
const Monitoring = lazy(() => import('./pages/Monitoring'))
// Replay bundles the benchmark export, so it loads on first visit too.
const Replay = lazy(() => import('./pages/Replay'))

function PageLoading({ label }: { label: string }) {
  return (
    <div className="page pageload" role="status" aria-live="polite">
      <p className="kicker">loading {label}…</p>
      <div className="pageload__grid" aria-hidden="true">{Array.from({ length: 7 }, (_, i) => <span key={i} />)}</div>
    </div>
  )
}

/* The public demo's strip: what this is, and that nothing on it is a live call. */
function DemoBanner({ replay }: { replay: boolean }) {
  return (
    <div className="demobar" role="note">
      <p>
        <b>Public demo</b>
        <span> · {replay ? 'verdicts from the real AVAL benchmark run' : `verdicts recorded from the real AVAL engine on ${ROTA_RECORDED_ON}`}</span>
        <span> · Cerrado Capital is fictional</span>
      </p>
      <nav aria-label="AVAL site">
        <a href={SITE_URL}>← aval-labs</a>
        <a href={DOCS_URL}>Docs</a>
      </nav>
    </div>
  )
}

/* A route the public demo leaves out because it needs a running service. */
function DemoUnavailable({ what }: { what: string }) {
  return (
    <div className="page">
      <header className="page__head">
        <p className="kicker">not in the public demo</p>
        <h1>{what} needs a running engine.</h1>
        <p className="lede">
          This public demo is static: it replays verdicts recorded from the real AVAL engine and talks to no server.
          {' '}{what} runs next to the engine; see the <a href={DOCS_URL}>docs</a> to run it yourself.
        </p>
      </header>
      <p><a className="demobtn" href="#/live">Go to the Live gate</a> <a className="demobtn" href="#/replay/focus">Benchmark replay</a></p>
    </div>
  )
}
const HIDDEN_NAME: Record<string, string> = { evaluate: 'The Scenario Lab', deploy: 'Deploy', system: 'System health' }

const NAV_ALL = [
  { group: 'monitor', items: [
    { k: 'live', label: 'Live gate', g: '◉' },
    { k: 'overview', label: 'Overview', g: '◇' },
    { k: 'issues', label: 'Issues', g: '⚑' },
    { k: 'monitoring', label: 'Monitoring', g: '∿' },
    { k: 'actions', label: 'Actions', g: '≡' },
    { k: 'review', label: 'Review', g: '◎' },
    { k: 'replay', label: 'Replay', g: '↻' },
  ] },
  { group: 'operate', items: [
    { k: 'evaluate', label: 'Scenario Lab', g: '▷' },
    { k: 'agents', label: 'Agents', g: '⌬' },
  ] },
  { group: 'configure', items: [
    { k: 'policy', label: 'Policy', g: '⚖' },
    { k: 'manifests', label: 'Manifests', g: '▤' },
    { k: 'lists', label: 'Lists', g: '☰' },
  ] },
  { group: 'ship', items: [
    { k: 'deploy', label: 'Deploy', g: '⇪' },
    { k: 'system', label: 'System', g: '⌁' },
  ] },
]

const NAV = DEMO
  ? NAV_ALL.map((g) => ({ ...g, items: g.items.filter((n) => !DEMO_HIDDEN.has(n.k)) })).filter((g) => g.items.length)
  : NAV_ALL

export default function App() {
  const route = useRoute()
  const engine = useEngine()
  const reduced = useReduced()
  const cfg = useConfig()
  const pending = diff(cfg.history[0].config, cfg.draft).length
  const [page = 'live', arg, arg2] = route
  const key = route.join('/') || 'live'

  let view
  if (DEMO && DEMO_HIDDEN.has(page)) view = <DemoUnavailable what={HIDDEN_NAME[page]} />
  else if (page === 'live') view = <Live />
  else if (page === 'issues') view = <Issues id={arg} />
  else if (page === 'evaluate') view = <Evaluate preset={arg} />
  else if (page === 'actions' && arg) view = <TraceView id={arg} />
  else if (page === 'actions') view = <Actions />
  else if (page === 'review') view = <Review />
  else if (page === 'overview' && arg === 'inspect' && arg2) view = <Inspect id={arg2} />
  else if (page === 'monitoring') view = <Suspense fallback={<PageLoading label="monitoring" />}><Monitoring /></Suspense>
  else if (page === 'replay') view = <Suspense fallback={<PageLoading label="replay" />}><Replay focus={arg === 'focus'} /></Suspense>
  else if (page === 'policy') view = <Policy />
  else if (page === 'manifests') view = <Manifests />
  else if (page === 'lists') view = <Lists />
  else if (page === 'agents') view = <Agents />
  else if (page === 'deploy') view = <Deploy />
  else if (page === 'system') view = <System />
  else view = <Overview />

  return (
    <div className="shell">
      <a href="#main" className="skip">Skip to content</a>
      <aside className="rail">
        <a className="rail__brand" href={DEMO ? SITE_URL : '/'} aria-label="AVAL site">
          <Logo className="rail__logo" label="AVAL" />
          <em>console</em>
        </a>
        <span className="rail__org" title={`Workspace: ${COMPANY.name}, ${COMPANY.city}. A made-up company for the demo.`}>{COMPANY.name}{COMPANY.fictional && <small>fictional</small>}</span>
        <nav className="rail__nav" aria-label="Console">
          {NAV.map((grp) => (
            <div key={grp.group} className="rail__group">
              <span className="rail__glabel">{grp.group}</span>
              {grp.items.map((n) => {
                const on = page === n.k
                return (
                  <a key={n.k} href={`#/${n.k}`} className={on ? 'is-on' : ''} aria-current={on ? 'page' : undefined}>
                    {on && <motion.span layoutId="rail-hl" className="rail__hl" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                    <span className="rail__g" aria-hidden="true">{n.g}</span>
                    <Scramble text={n.label} />
                    {n.k === 'deploy' && pending > 0 && <span className="rail__badge" aria-label={`${pending} unpublished changes`}>{pending}</span>}
                  </a>
                )
              })}
            </div>
          ))}
        </nav>
        <button type="button" className="rail__k" onClick={() => dispatchEvent(new Event('aval:palette'))}>
          <span>Search</span><kbd>⌘K</kbd>
        </button>
        <ThemeToggle className="rail__theme" />
        <div className={`rail__engine engine engine--${engine === 'no-fixtures' || engine === 'recorded' ? 'offline' : engine}`}>
          <i aria-hidden="true" />
          {engine === 'recorded' ? (
            <span>
              recorded verdicts
              <small>AVAL engine · {ROTA_RECORDED_ON}</small>
            </span>
          ) : (
            <span>
              {engine === 'live' ? 'engine live' : engine === 'offline' ? 'engine offline' : engine === 'no-fixtures' ? 'engine lacks fixtures' : 'checking…'}
              <small>{engine === 'offline' || engine === 'no-fixtures' ? 'showing recorded verdicts' : 'veto demo · /veto'}</small>
            </span>
          )}
        </div>
      </aside>

      <main id="main" className="main">
        {DEMO && <DemoBanner replay={page === 'replay'} />}
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
      <ChangeBar />
      <CommandPalette />
      <Toasts />
    </div>
  )
}
