import { useEffect, useState } from 'react'
import Logo from '../components/Logo'
import ThemeToggle from '../components/ThemeToggle'
import Content, { SECTIONS } from './content'
import { REPO } from './parts'

type Toc = Record<string, { id: string; text: string }[]>

/* Headings under each section, read from the rendered page so the TOC never drifts from the content. */
function readToc(): Toc {
  const toc: Toc = {}
  document.querySelectorAll<HTMLElement>('.d-sec').forEach((sec) => {
    const h2 = sec.querySelector('h2')
    if (!h2) return
    toc[h2.id] = [...sec.querySelectorAll<HTMLElement>('h3[data-toc]')].map((h) => ({
      id: h.id,
      text: (h.textContent ?? '').replace(/#$/, '').trim(),
    }))
  })
  return toc
}

/* The last heading whose top has passed the line under the header. */
function useSpy(): { sec: string; sub: string } {
  const [cur, setCur] = useState({ sec: SECTIONS[0][0] as string, sub: '' })
  useEffect(() => {
    let raf = 0
    const run = () => {
      raf = 0
      // Just below where an anchor jump lands a heading (scroll-margin in docs.css).
      const line = (document.querySelector('.d-top')?.getBoundingClientRect().bottom ?? 68) + 96
      let sec: string = SECTIONS[0][0]
      let sub = ''
      document.querySelectorAll<HTMLElement>('.d-h').forEach((h) => {
        if (h.getBoundingClientRect().top <= line) {
          if (h.tagName === 'H2') { sec = h.id; sub = '' } else sub = h.id
        }
      })
      // At the very bottom the last section may never reach the line.
      if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) {
        sec = SECTIONS[SECTIONS.length - 1][0]; sub = ''
      }
      setCur((c) => (c.sec === sec && c.sub === sub ? c : { sec, sub }))
    }
    const on = () => { if (!raf) raf = requestAnimationFrame(run) }
    run()
    addEventListener('scroll', on, { passive: true })
    addEventListener('resize', on)
    return () => { removeEventListener('scroll', on); removeEventListener('resize', on); cancelAnimationFrame(raf) }
  }, [])
  return cur
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

export default function DocsApp() {
  const { sec, sub } = useSpy()
  const [toc, setToc] = useState<Toc>({})
  const [menu, setMenu] = useState(false)
  useEffect(() => { setToc(readToc()) }, [])

  // Arriving with a #hash: the content renders after the browser tried to scroll, so do it now.
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1))
    if (id) document.getElementById(id)?.scrollIntoView({ behavior: 'instant' })
  }, [])

  useEffect(() => {
    if (!menu) return
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false) }
    addEventListener('keydown', close)
    return () => removeEventListener('keydown', close)
  }, [menu])

  const label = SECTIONS.find(([id]) => id === sec)?.[1] ?? 'Overview'
  const subs = toc[sec] ?? []

  return (
    <>
      <a className="d-skip" href="#content">Skip to content</a>
      <header className="nav d-top">
        <div className="d-top__inner">
          <a href="/" className="nav__brand d-brand" aria-label="AVAL home">
            <Logo className="nav__logo" label="AVAL" />
            <span className="d-brand__tag">docs</span>
          </a>
          <div className="d-top__right">
            <a href="/" className="d-top__link d-hide-sm">← back to aval-labs</a>
            <a href={REPO} target="_blank" rel="noreferrer" className="d-top__link d-gh" aria-label="Aval on GitHub">
              <GitHubMark /><span className="d-hide-sm">github</span>
            </a>
            <ThemeToggle />
          </div>
        </div>
        <button
          type="button"
          className="d-menubtn"
          aria-expanded={menu}
          aria-controls="d-side"
          onClick={() => setMenu((m) => !m)}
        >
          <span className="d-menubtn__label"><span className="d-menubtn__k">section</span>{label}</span>
          <span className="d-menubtn__plus" aria-hidden="true">{menu ? '−' : '+'}</span>
        </button>
      </header>

      <div className="d-shell">
        <aside id="d-side" className={`d-side ${menu ? 'is-open' : ''}`}>
          <nav aria-label="Documentation">
            <p className="d-side__k">documentation</p>
            <ol>
              {SECTIONS.map(([id, l], i) => (
                <li key={id}>
                  <a href={`#${id}`} className={sec === id ? 'is-on' : ''} aria-current={sec === id ? 'true' : undefined} onClick={() => setMenu(false)}>
                    <span>{String(i).padStart(2, '0')}</span>{l}
                  </a>
                  {/* On small screens the headings live here instead of a right rail. */}
                  {sec === id && (toc[id]?.length ?? 0) > 0 && (
                    <ul className="d-side__sub">
                      {toc[id].map((h) => (
                        <li key={h.id}><a href={`#${h.id}`} className={sub === h.id ? 'is-on' : ''} onClick={() => setMenu(false)}>{h.text}</a></li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
            <div className="d-side__out">
              <a href="/">← back to aval-labs</a>
              <a href={REPO} target="_blank" rel="noreferrer">GitHub ↗</a>
            </div>
          </nav>
        </aside>

        <main id="content" className="d-main">
          <Content />
          <footer className="d-foot">
            <span>AVAL · built for VETO · Superteam Brasil 2026</span>
            <span className="d-foot__links">
              <a href="/">Home</a>
              <a href="#overview">Docs</a>
              <a href={REPO} target="_blank" rel="noreferrer">GitHub</a>
            </span>
          </footer>
        </main>

        <aside className="d-toc" aria-label="On this page">
          <p className="d-side__k">on this page</p>
          <p className="d-toc__sec">{label}</p>
          <ul>
            {subs.map((h) => (
              <li key={h.id}><a href={`#${h.id}`} className={sub === h.id ? 'is-on' : ''}>{h.text}</a></li>
            ))}
          </ul>
          <a className="d-toc__top" href="#overview">↑ back to top</a>
        </aside>
      </div>
    </>
  )
}
