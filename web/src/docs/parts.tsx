import { useRef, useState, type ReactNode } from 'react'

export const REPO = 'https://github.com/lusknchars/Aval'
export const blob = (path: string) => `${REPO}/blob/main/${path}`

/* A heading with its own anchor link; the id drives the sidebar and the TOC. */
export function H2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="d-h d-h2">
      {children}
      <a className="d-anchor" href={`#${id}`} aria-label="Link to this section">#</a>
    </h2>
  )
}
export function H3({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={id} className="d-h d-h3" data-toc>
      {children}
      <a className="d-anchor" href={`#${id}`} aria-label="Link to this heading">#</a>
    </h3>
  )
}

/* Code with a copy button. The text copied is exactly what is shown. */
export function Code({ children, lang, title }: { children: string; lang?: string; title?: string }) {
  const [copied, setCopied] = useState(false)
  const t = useRef(0)
  const text = children.replace(/^\n/, '').replace(/\s+$/, '')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta); ta.select()
      try { document.execCommand('copy') } catch { /* nothing else to try */ }
      ta.remove()
    }
    setCopied(true)
    clearTimeout(t.current)
    t.current = window.setTimeout(() => setCopied(false), 1600)
  }
  return (
    <div className="d-code">
      <div className="d-code__bar">
        <span>{title ?? lang ?? 'text'}</span>
        <button type="button" className="d-code__copy" onClick={copy} aria-label="Copy code">
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre><code>{text}</code></pre>
      <span className="sr-only" aria-live="polite">{copied ? 'Copied to clipboard' : ''}</span>
    </div>
  )
}

export function Note({ kind = 'info', title, children }: { kind?: 'info' | 'warn'; title?: string; children: ReactNode }) {
  return (
    <aside className={`d-note d-note--${kind}`}>
      {title && <p className="d-note__t">{title}</p>}
      {children}
    </aside>
  )
}

export function Table({ head, rows }: { head: ReactNode[]; rows: ReactNode[][] }) {
  return (
    <div className="d-table" role="region" aria-label="Table" tabIndex={0}>
      <table>
        <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className="d-link">{children}<span aria-hidden="true"> ↗</span></a>
}

const STAGES = [
  ['01', 'Intercept', 'unsigned tx held before the wallet signs'],
  ['02', 'Simulate', 'aval-svm runs it on a local copy of the chain'],
  ['03', 'Read effects', 'balance, authority and account changes'],
  ['04', 'Trace origin', 'where each address and amount came from'],
  ['05', 'Checks', 'named findings, each with a severity'],
  ['06', 'Decide', 'ALLOW · REVIEW · DENY'],
] as const

export function Pipeline() {
  return (
    <figure className="d-pipe" aria-label="The Aval pipeline">
      <ol>
        {STAGES.map(([n, name, sub], i) => (
          <li key={n} className={i === STAGES.length - 1 ? 'is-last' : ''}>
            <span className="d-pipe__n">{n}</span>
            <b>{name}</b>
            <span className="d-pipe__sub">{sub}</span>
          </li>
        ))}
      </ol>
      <div className="d-pipe__model">
        <span className="d-pipe__tag">model</span>
        <span>an opinion after step 06. It can move ALLOW → REVIEW or → DENY, never the other way.</span>
      </div>
      <figcaption>Nothing is signed or sent at any step. Missing information never becomes an ALLOW.</figcaption>
    </figure>
  )
}

export function Verdicts() {
  return (
    <div className="d-verdicts">
      <div className="d-v d-v--ok"><b>ALLOW</b><span>the effects match the request; the wallet may sign</span></div>
      <div className="d-v d-v--flag"><b>REVIEW</b><span>held for a person to look at before anything is signed</span></div>
      <div className="d-v d-v--deny"><b>DENY</b><span>blocked, with the named finding that caused it</span></div>
    </div>
  )
}

export function Stats({ items }: { items: [string, string][] }) {
  return (
    <dl className="d-stats">
      {items.map(([n, l]) => (
        <div key={l}><dt>{l}</dt><dd>{n}</dd></div>
      ))}
    </dl>
  )
}
