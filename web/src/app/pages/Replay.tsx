import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import data from '../snapshots/benchmark-replay.json'
import { COMPANY, AGENTS, THREAT, agentFor, type AgentId } from '../config/company'
import { Coin, coinInfo } from '../ui/Coin'
import Scramble from '../../components/Scramble'
import { useReduced } from '../../lib/useReduced'
import './replay.css'

/*
 * Benchmark replay: a sampled, seeded stream of real benchmark verdicts
 * (scripts/export-replay.mjs), dressed as a fictional company's agents.
 * Counters scale each (set, verdict) bucket of the sample to the real totals,
 * so they land exactly on the snapshot's numbers when the stream ends.
 */

type Verdict = 'ALLOW' | 'REVIEW' | 'BLOCK'
type Ev = {
  id: string; set: string; src: string; kind: string; action: string | null; asset: string | null; amt: string | null
  exp: string; code: string; fin: Verdict; layer: string | null; model: string | null; sig: string[]; why: string | null
  note: string | null; usd: number | null; code_us: number; model_ms: number | null; dg: string | null
}
type SetTotals = {
  cases: number; expected: { ALLOW: number; BLOCK: number }; final: Record<Verdict, number>; code_only: { ALLOW: number; BLOCK: number }
  fp: number; fn: number; model_done: number; usd: { attack_blocked: number }
}

const EVENTS = data.events as Ev[]
const T = data.totals as unknown as { cases: number; sets: Record<'real_traffic' | 'attack_real_tx' | 'attack_constructed', SetTotals>; latency: { code_p50_us: number; model_p50_ms: number } }
const BUCKETS = data.buckets as Record<string, { total: number; shown: number }>
const N = EVENTS.length
const RT = T.sets.real_traffic, AR = T.sets.attack_real_tx, AC = T.sets.attack_constructed

const BADGE: Record<Verdict, string> = { ALLOW: 'allow', REVIEW: 'flag', BLOCK: 'deny' }
const SPEEDS = [1, 4, 16]
const BASE_MS = 1000
const FEED = 12

const int = new Intl.NumberFormat('en-US')
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—')
const usd = (x: number) => `US$ ${int.format(Math.round(x))}`
const snapAt = (() => {
  const t = data.source.snapshot_at ? new Date(data.source.snapshot_at) : null
  if (!t) return 'time unknown'
  const d = t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  return `${d}, ${t.toISOString().slice(11, 16)} UTC`
})()

/* Prefix counts per bucket, so any position in the stream maps straight to scaled totals. */
const PREFIX: Record<string, number[]> = {}
for (const k of Object.keys(BUCKETS)) PREFIX[k] = [0]
EVENTS.forEach((e) => {
  for (const k of Object.keys(PREFIX)) PREFIX[k].push(PREFIX[k][PREFIX[k].length - 1] + (`${e.set}|${e.fin}` === k ? 1 : 0))
})
function scaled(key: string, i: number) {
  const b = BUCKETS[key]
  if (!b) return 0
  if (i >= N) return b.total
  return b.shown ? Math.round((b.total * PREFIX[key][i]) / b.shown) : 0
}
const sum = (keys: string[], i: number) => keys.reduce((a, k) => a + scaled(k, i), 0)

const AGENT_OF = EVENTS.map((e) => agentFor(e))

function sym(e: Ev) {
  if (!e.asset) return ''
  const c = coinInfo(e.asset)
  return c.name.startsWith('token ') ? `${e.asset.slice(0, 4)}…` : c.sym
}
function amount(s: string | null) {
  if (!s) return ''
  if (s === 'unlimited') return 'unlimited'
  const n = Number(s)
  if (!Number.isFinite(n)) return s
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 2 })
}
function tried(e: Ev) {
  const a = amount(e.amt), s = sym(e)
  switch (e.action) {
    case 'swap': return `swap ${a} ${s}`.trim()
    case 'transfer_sol': return `send ${a} SOL`
    case 'transfer_token': return `send ${a} ${s}`.trim()
    case 'approve': return `approve ${a} ${s} for a spender`.replace(/\s+/g, ' ')
    case 'set_authority': return 'change a token account’s authority'
    case 'close': return 'close a token account'
    case 'create': return 'open a token account'
    default: return 'run a dapp transaction'
  }
}
function decidedBy(e: Ev) {
  if (e.fin === 'BLOCK') return e.layer === 'B' ? 'blocked by code · injection check' : e.layer === 'C' ? 'blocked by the intent model' : 'blocked by code · simulation vs intent'
  if (e.fin === 'REVIEW') return 'held by the intent model'
  if (e.model === null) return 'passed code · model not run'
  if (e.model === 'invalid') return 'passed code · model gave no answer'
  return 'passed code · model: low risk'
}
const latencyOf = (e: Ev) => `${e.code_us} µs${e.model_ms != null ? ` · model ${(e.model_ms / 1000).toFixed(1)} s` : ''}`

/* A number that eases to its new value (instant under reduced motion). */
function useTween(value: number, ms: number, off: boolean) {
  const [v, setV] = useState(value)
  const from = useRef(value)
  useEffect(() => {
    if (off) { from.current = value; setV(value); return }
    let raf = 0
    const a = from.current, t0 = performance.now()
    const step = () => {
      const k = Math.max(0, Math.min(1, (performance.now() - t0) / ms))
      const x = a + (value - a) * (1 - Math.pow(1 - k, 3))
      from.current = x
      setV(x)
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value, ms, off])
  return v
}

function Num({ v, ms, off, fmt = (x: number) => int.format(Math.round(x)) }: { v: number; ms: number; off: boolean; fmt?: (x: number) => string }) {
  return <>{fmt(useTween(v, ms, off))}</>
}

export default function Replay({ focus = false }: { focus?: boolean }) {
  const reduced = useReduced()
  const [i, setI] = useState(0) // events shown
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const done = i >= N

  useEffect(() => {
    document.documentElement.classList.toggle('rp-focus', focus)
    return () => document.documentElement.classList.remove('rp-focus')
  }, [focus])

  // Advance one event at a time; blocks linger a little at 1× so they can be read.
  useEffect(() => {
    if (!playing || done) return
    const next = EVENTS[i]
    const wait = (BASE_MS * (next?.fin === 'BLOCK' && speed === 1 ? 1.6 : 1)) / speed
    const t = setTimeout(() => setI((n) => Math.min(N, n + 1)), i === 0 ? 400 : wait)
    return () => clearTimeout(t)
  }, [playing, done, i, speed])

  const restart = useCallback(() => { setI(0); setPlaying(true) }, [])
  const toEnd = useCallback(() => { setI(N); setPlaying(false) }, [])

  useEffect(() => {
    const on = (ev: KeyboardEvent) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey || (ev.target as HTMLElement)?.closest('input, textarea, [contenteditable]')) return
      if (ev.key === ' ') { ev.preventDefault(); setPlaying((p) => !p) }
      else if (ev.key === 'r') restart()
      else if (ev.key === 'e') toEnd()
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [restart, toEnd])

  // Scaled counters at the current position.
  const rtAllow = scaled('real_traffic|ALLOW', i), rtReview = scaled('real_traffic|REVIEW', i), rtBlock = scaled('real_traffic|BLOCK', i)
  const rtSeen = rtAllow + rtReview + rtBlock
  const allKeys = Object.keys(BUCKETS)
  const checked = sum(allKeys, i)
  const allowed = sum(allKeys.filter((k) => k.endsWith('|ALLOW')), i)
  const held = sum(allKeys.filter((k) => k.endsWith('|REVIEW')), i)
  const blocked = sum(allKeys.filter((k) => k.endsWith('|BLOCK')), i)
  const arBlocked = scaled('attack_real_tx|BLOCK', i)
  const acBlocked = scaled('attack_constructed|BLOCK', i)
  const twinsAllowed = scaled('attack_constructed|ALLOW', i)
  const arShare = BUCKETS['attack_real_tx|BLOCK'] ? arBlocked / BUCKETS['attack_real_tx|BLOCK'].total : 0
  const protectedUsd = AR.usd.attack_blocked * arShare

  const tw = reduced ? 0 : Math.min(700, BASE_MS / speed)
  const feed = useMemo(() => EVENTS.slice(Math.max(0, i - FEED), i).map((e, k) => ({ e, n: Math.max(0, i - FEED) + k })).reverse(), [i])

  const byAgent = useMemo(() => {
    const m = new Map<AgentId, Record<Verdict, number>>(AGENTS.map((a) => [a.id, { ALLOW: 0, REVIEW: 0, BLOCK: 0 }]))
    for (let k = 0; k < i; k++) m.get(AGENT_OF[k])![EVENTS[k].fin]++
    return m
  }, [i])

  return (
    <div className={`page rp ${focus ? 'rp--focus' : ''}`}>
      <header className="rp__head">
        <div className="rp__title">
          <Scramble as="p" text="benchmark replay" className="kicker" />
          <h1>{COMPANY.name} <span className="rp__fic">fictional company</span></h1>
          <p className="rp__sub">
            {COMPANY.name} · fictional company · replay of the Aval benchmark on real Solana mainnet transactions (snapshot {snapAt})
          </p>
          <p className="rp__blurb">{COMPANY.city} · {COMPANY.blurb}. The agents are made up; every verdict below is a real benchmark result.</p>
        </div>
        <div className="live__ctl rp__ctl">
          <button type="button" className="live__play" onClick={() => (done ? restart() : setPlaying((p) => !p))} aria-pressed={!playing}>
            {done ? '↺ replay' : playing ? '❚❚ pause' : '▶ play'}
          </button>
          <div className="live__speed" role="group" aria-label="Replay speed">
            {SPEEDS.map((s) => (
              <button key={s} type="button" className={speed === s ? 'is-on' : ''} aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}×</button>
            ))}
          </div>
          <button type="button" className="live__play" onClick={toEnd} disabled={done}>⇥ totals</button>
          <button type="button" className="live__play" onClick={restart}>↺ restart</button>
          <a className="live__play rp__focuslink" href={focus ? '#/replay' : '#/replay/focus'} title={focus ? 'Show the console menu' : 'Hide the console menu for recording'}>
            {focus ? '⤡ menu' : '⤢ focus'}
          </a>
        </div>
      </header>

      <div className="rp__progress" aria-hidden="true"><i style={{ transform: `scaleX(${i / N})` }} /></div>

      <section className="live__kpis rp__kpis" aria-label="Running totals">
        <div>
          <span>cases checked</span>
          <b><Num v={checked} ms={tw} off={reduced} /></b>
          <small>of {int.format(T.cases)} cases</small>
        </div>
        <div className="is-allow"><span>allowed</span><b><Num v={allowed} ms={tw} off={reduced} /></b><small>signed without a human</small></div>
        <div className="is-flag"><span>review</span><b><Num v={held} ms={tw} off={reduced} /></b><small>held for a human</small></div>
        <div className="is-deny"><span>blocked</span><b><Num v={blocked} ms={tw} off={reduced} /></b><small>never signed</small></div>
        <div><span>replay</span><b>{i}<em>/{N}</em></b><small>sampled events shown</small></div>
      </section>

      <div className="rp__grid">
        <div className="rp__left">
          <section className="rp__feedcol" aria-label="Verdicts">
            <h2 className="live__h">verdicts, newest first</h2>
            {i === 0 && <p className="live__wait">agents are starting their shift…</p>}
            <ol className="rp__feed" aria-live="off">
              <AnimatePresence initial={false}>
                {feed.map(({ e, n }) => <Row key={n} e={e} agent={AGENT_OF[n]} reduced={reduced} />)}
              </AnimatePresence>
            </ol>
          </section>
          <section className="rp__agents" aria-label="Events by agent in this replay">
            {AGENTS.map((a) => {
              const c = byAgent.get(a.id)!
              return (
                <div key={a.id} className="rp__agent">
                  <b>{a.id}</b>
                  <small>{a.job}</small>
                  <span className="rp__agentn">
                    <span>{c.ALLOW} allow</span>
                    <span className="is-flag">{c.REVIEW} review</span>
                    <span className="is-deny">{c.BLOCK} block</span>
                  </span>
                </div>
              )
            })}
          </section>
        </div>

        <aside className="rp__tiles" aria-label="Benchmark totals">
          <div className="rp__tile">
            <h2 className="live__h">real mainnet traffic</h2>
            <div className="rp__big"><b className="is-ok"><Num v={rtBlock} ms={tw} off={reduced} /></b><span>false blocks<br />in <Num v={rtSeen} ms={tw} off={reduced} /> of {int.format(RT.cases)} real transactions</span></div>
            <div className="rp__split">
              <span><b>{rtSeen ? pct(rtAllow, rtSeen) : '—'}</b> auto-ALLOW</span>
              <span className="is-flag"><b>{rtSeen ? pct(rtReview, rtSeen) : '—'}</b> REVIEW</span>
            </div>
            <div className="rp__bar" aria-hidden="true"><i style={{ flexGrow: rtAllow || 0 }} /><i className="is-flag" style={{ flexGrow: rtReview || 0 }} /></div>
            <p className="rp__note">Code layers alone allowed {pct(RT.code_only.ALLOW, RT.cases)}. Every REVIEW came from the intent model, which had answered {pct(RT.model_done, RT.cases)} of these cases.</p>
          </div>

          <div className="rp__tile">
            <h2 className="live__h">attacks blocked</h2>
            <Ratio label="on real transactions" n={arBlocked} of={AR.expected.BLOCK} ms={tw} off={reduced} />
            <Ratio label="constructed (local VM)" n={acBlocked} of={AC.expected.BLOCK} ms={tw} off={reduced} />
            <Ratio label="benign twins allowed" n={twinsAllowed} of={AC.expected.ALLOW} ms={tw} off={reduced} calm />
          </div>

          <div className="rp__tile">
            <h2 className="live__h">US$ protected</h2>
            <div className="rp__big"><b><Num v={protectedUsd} ms={tw} off={reduced} fmt={usd} /></b></div>
            <p className="rp__note">Value that would have left the signer in the blocked attacks on real transactions, at the CoinGecko price when each case ran.</p>
          </div>

          <div className="rp__tile">
            <h2 className="live__h">latency · p50</h2>
            <div className="rp__lat">
              <span><b>{T.latency.code_p50_us} µs</b>code layers</span>
              <span><b>{(T.latency.model_p50_ms / 1000).toFixed(2)} s</b>intent model</span>
            </div>
          </div>
        </aside>
      </div>


      <footer className="rp__foot">
        <p>
          {COMPANY.name} and its agents are fictional; each case goes to an agent by what the transaction does.
          Attacks are test cases forged by the benchmark: a real mainnet transaction with one forged intent, or a transaction built on a local VM with its honest twin.
          REVIEW means held for a human, never blocked. The intent model can only add caution: the final verdict is the strictest layer's.
          Code-layer catches match the attack labels by construction, since both come from the same comparison rules.
          Counters scale the {N} sampled events to the {int.format(T.cases)} cases of the snapshot; the agent strip counts sampled events.
          {data.source.done === false && ' The benchmark was still running when this snapshot was taken.'}
        </p>
      </footer>
    </div>
  )
}

function Ratio({ label, n, of, ms, off, calm = false }: { label: string; n: number; of: number; ms: number; off: boolean; calm?: boolean }) {
  return (
    <div className={`rp__ratio ${calm ? 'is-calm' : ''}`}>
      <span className="rp__ratio-l">{label}</span>
      <b><Num v={n} ms={ms} off={off} /><em>/{int.format(of)}</em></b>
      <span className="rp__ratio-bar" aria-hidden="true"><i style={{ transform: `scaleX(${of ? n / of : 0})` }} /></span>
    </div>
  )
}

function Row({ e, agent, reduced }: { e: Ev; agent: AgentId; reduced: boolean }) {
  const block = e.fin === 'BLOCK'
  return (
    <motion.li
      layout={!reduced}
      initial={reduced ? false : { opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? undefined : { opacity: 0, transition: { duration: 0.12 } }}
      transition={{ type: 'spring', stiffness: 420, damping: 36 }}
      className={`rprow rprow--${BADGE[e.fin]}`}
    >
      <span className={`dbadge dbadge--${BADGE[e.fin]} dbadge--sm`}>{e.fin}</span>
      <span className="rprow__coin">{e.asset ? <Coin mint={e.asset} /> : <span className="lrow__nocoin">·</span>}</span>
      <span className="rprow__what"><b>{agent}</b>{tried(e)}</span>
      <span className="rprow__src">{e.set === 'attack_constructed' ? 'constructed' : 'mainnet'}</span>
      <span className="rprow__by">{decidedBy(e)}</span>
      <span className="rprow__ms">{latencyOf(e)}{e.dg && <> · {e.dg}</>}</span>
      {block && (
        <span className="rprow__threat">
          <b>{THREAT[e.kind] ?? e.kind.replace(/_/g, ' ')}</b>
          {e.sig.map((s) => <code key={s}>{s}</code>)}
          {e.usd != null && e.usd > 0 && <span className="rprow__usd">{e.usd >= 1 ? usd(e.usd) : `US$ ${e.usd.toFixed(2)}`} at stake</span>}
          {e.note && <span className="rprow__note">note: “{e.note}”</span>}
        </span>
      )}
      {e.fin === 'REVIEW' && e.sig.length > 0 && (
        <span className="rprow__threat rprow__threat--flag">
          <span>model flagged</span>{e.sig.map((s) => <code key={s}>{s}</code>)}
        </span>
      )}
    </motion.li>
  )
}
