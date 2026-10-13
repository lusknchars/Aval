#!/usr/bin/env node
/*
 * Export a compact, deterministic replay of the Aval 20k benchmark for the
 * console's #/replay page.
 *
 *   node scripts/export-replay.mjs                 # frozen snapshot (default)
 *   node scripts/export-replay.mjs --live           # the run in results/bench20k/
 *   node scripts/export-replay.mjs --dir <path>     # any results dir with events.jsonl + cases.jsonl
 *   options: --out <file> --n <events> --seed <int>
 *
 * Reads only. It never writes into the dataset directory. Totals are
 * recomputed from events.jsonl (decision + model joined by case_id, as the
 * benchmark contract says); summary.json is copied for reference only.
 */
import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const BENCH = join(homedir(), 'veto-lab-2-dataset/results/bench20k')
const SNAPSHOT = join(BENCH, 'snapshot-20261011-0619')

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const live = args.includes('--live')
const dir = resolve(opt('--dir', live ? BENCH : SNAPSHOT))
const out = resolve(opt('--out', join(import.meta.dirname, '../src/app/snapshots/benchmark-replay.json')))
const N = Number(opt('--n', 500))
const SEED = Number(opt('--seed', 20261011))

if (!existsSync(join(dir, 'events.jsonl'))) { console.error(`no events.jsonl in ${dir}`); process.exit(1) }
if (out.startsWith(join(homedir(), 'veto-lab-2-dataset'))) { console.error('refusing to write into the dataset'); process.exit(1) }

/* ── read ─────────────────────────────────────────────────────────── */
async function* lines(file) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const l of rl) if (l.trim()) yield l
}

const dec = new Map() // case_id -> decision event
const mod = new Map() // case_id -> model event (tuned)
let lastTs = ''
let bad = 0
for await (const l of lines(join(dir, 'events.jsonl'))) {
  let e
  try { e = JSON.parse(l) } catch { bad++; continue } // a line still being written
  if (e.ts && e.ts > lastTs) lastTs = e.ts
  if (e.type === 'decision') dec.set(e.case_id, e)
  else if (e.type === 'model' && e.model === 'tuned') mod.set(e.case_id, e)
}

/* ── join ─────────────────────────────────────────────────────────── */
const SETS = ['real_traffic', 'attack_real_tx', 'attack_constructed']
const cases = []
for (const [id, d] of dec) {
  const m = mod.get(id)
  const fin = m ? m.final : d.decision
  // Who decided the final verdict: the model's `layer` covers A/B/C; without a model answer, A/B's.
  const layer = m ? m.layer : d.layer
  cases.push({ id, d, m, fin, layer })
}

const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b), k = s.length >> 1
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2
}
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100)

/* ── totals (recomputed from events) ──────────────────────────────── */
const sets = {}
for (const s of SETS) {
  const cs = cases.filter((c) => c.d.set === s)
  const t = {
    cases: cs.length,
    expected: { ALLOW: 0, BLOCK: 0 },
    final: { ALLOW: 0, REVIEW: 0, BLOCK: 0 },
    code_only: { ALLOW: 0, BLOCK: 0 },
    fp: 0, fn: 0, review_legit: 0, review_attack: 0,
    decided_by: {},
    by_kind: {},
    model_done: 0,
    usd: { attack_blocked: 0, legit_allowed: 0, legit_review: 0, priced: 0 },
    latency: {},
  }
  for (const c of cs) {
    const exp = c.d.expected
    t.expected[exp]++
    t.final[c.fin]++
    t.code_only[c.d.decision]++
    if (exp === 'ALLOW' && c.fin === 'BLOCK') t.fp++
    if (exp === 'BLOCK' && c.fin !== 'BLOCK') t.fn++
    if (c.fin === 'REVIEW') exp === 'ALLOW' ? t.review_legit++ : t.review_attack++
    const by = c.layer ?? '—'
    t.decided_by[by] = (t.decided_by[by] ?? 0) + 1
    const k = (t.by_kind[c.d.kind] ??= { ALLOW: 0, REVIEW: 0, BLOCK: 0 })
    k[c.fin]++
    if (c.m) t.model_done++
    if (typeof c.d.usd === 'number') {
      t.usd.priced++
      if (exp === 'BLOCK' && c.fin === 'BLOCK') t.usd.attack_blocked += c.d.usd
      if (exp === 'ALLOW' && c.fin === 'ALLOW') t.usd.legit_allowed += c.d.usd
      if (exp === 'ALLOW' && c.fin === 'REVIEW') t.usd.legit_review += c.d.usd
    }
  }
  for (const k of Object.keys(t.usd)) t.usd[k] = r2(t.usd[k])
  const code = cs.map((c) => (c.d.latency_ms?.A ?? 0) + (c.d.latency_ms?.B ?? 0))
  const model = cs.filter((c) => c.m && typeof c.m.latency_ms === 'number').map((c) => c.m.latency_ms)
  t.latency = { code_p50_us: r2(median(code) * 1000), model_p50_ms: r2(median(model)), model_n: model.length }
  sets[s] = t
}
const allCode = cases.map((c) => (c.d.latency_ms?.A ?? 0) + (c.d.latency_ms?.B ?? 0))
const allModel = cases.filter((c) => c.m && typeof c.m.latency_ms === 'number').map((c) => c.m.latency_ms)

let summary = {}
try { summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) } catch { /* optional */ }

/* ── seeded selection ─────────────────────────────────────────────── */
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const rnd = mulberry32(SEED)
const shuffle = (xs) => { const a = [...xs].sort((x, y) => (x.id < y.id ? -1 : 1)); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }

/* Stratified sample: every group gets min(minPer, size), the rest is shared by size. */
function strat(items, key, n, minPer = 1) {
  const groups = new Map()
  for (const it of shuffle(items)) { const k = key(it); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it) }
  const ks = [...groups.keys()].sort()
  const take = new Map(ks.map((k) => [k, Math.min(minPer, groups.get(k).length)]))
  let left = Math.max(0, n - [...take.values()].reduce((a, b) => a + b, 0))
  const total = items.length
  const want = ks.map((k) => ({ k, x: (groups.get(k).length / total) * left }))
  for (const w of want) { const add = Math.min(Math.floor(w.x), groups.get(w.k).length - take.get(w.k)); take.set(w.k, take.get(w.k) + add) }
  left = Math.max(0, n - [...take.values()].reduce((a, b) => a + b, 0))
  for (const w of want.sort((a, b) => (b.x % 1) - (a.x % 1))) {
    if (!left) break
    if (take.get(w.k) < groups.get(w.k).length) { take.set(w.k, take.get(w.k) + 1); left-- }
  }
  return ks.flatMap((k) => groups.get(k).slice(0, take.get(k)))
}

const of = (s, f) => cases.filter((c) => c.d.set === s && f(c))
const rt = sets.real_traffic
const nAttack = Math.round(N / 10)
const nReal = Math.round(N * 0.8)
const nRtAllow = Math.round(nReal * (rt.final.ALLOW / Math.max(1, rt.cases)))
const nRtOther = nReal - nRtAllow
const nAr = Math.round(nAttack * 0.45)
const nAc = nAttack - nAr
const nTwin = N - nReal - nAttack

const pickRtAllow = strat(of('real_traffic', (c) => c.fin === 'ALLOW'), (c) => c.d.kind, nRtAllow, 6)
const pickRtOther = strat(of('real_traffic', (c) => c.fin !== 'ALLOW'), (c) => `${c.d.kind}|${c.fin}`, nRtOther, 1)
const pickAr = strat(of('attack_real_tx', () => true), (c) => `${c.d.kind}|${c.fin}`, nAr, 2)
const pickAc = strat(of('attack_constructed', (c) => c.d.expected === 'BLOCK'), (c) => `${c.d.kind}|${c.fin}`, nAc, 3)
const pickTwin = strat(of('attack_constructed', (c) => c.d.expected === 'ALLOW'), (c) => `${c.d.kind}|${c.fin}`, nTwin, 3)

/* Spread each (set, verdict) bucket evenly through the stream, so the running
   counters and percentages track the real proportions from the first minute. */
function spread(items) {
  const groups = new Map()
  for (const it of shuffle(items)) { const k = `${it.d.set}|${it.fin}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it) }
  const keyed = []
  for (const g of groups.values()) g.forEach((it, j) => keyed.push({ it, at: (j + 0.1 + rnd() * 0.8) / g.length }))
  return keyed.sort((a, b) => a.at - b.at).map((x) => x.it)
}

/* Interleave: a first attack early, then one every 8–12 events. */
const calm = spread([...pickRtAllow, ...pickRtOther, ...pickTwin])
const attacks = spread([...pickAr, ...pickAc])
const stream = []
let gap = 3 + Math.floor(rnd() * 3)
while (calm.length || attacks.length) {
  for (let i = 0; i < gap && calm.length; i++) stream.push(calm.shift())
  if (attacks.length) stream.push(attacks.shift())
  gap = 7 + Math.floor(rnd() * 5)
}

/* ── per-event fields the UI needs ────────────────────────────────── */
const want = new Set(stream.map((c) => c.id))
const intent = new Map()
if (existsSync(join(dir, 'cases.jsonl'))) {
  for await (const l of lines(join(dir, 'cases.jsonl'))) {
    const id = /"case_id"\s*:\s*"([^"]+)"/.exec(l.slice(0, 200))?.[1]
    if (!id || !want.has(id)) continue
    try { const c = JSON.parse(l); intent.set(id, { ...c.intent, meta: c.metadata ?? {} }) } catch { /* skip */ }
  }
}

const cut = (s, n) => (s == null ? null : (s = String(s).replace(/\s+/g, ' ').trim()).length > n ? s.slice(0, n - 1) + '…' : s)
const shortDigest = (d) => (d ? `${d.slice(0, 8)}…${d.slice(-4)}` : null)
const modelReason = (m) => { try { return JSON.parse(m.raw)?.reasons?.[0] ?? null } catch { return null } }

const events = stream.map((c) => {
  const d = c.d, m = c.m, it = intent.get(c.id) ?? {}
  const sig = c.fin === 'REVIEW' && m ? m.signals : (d.signals?.length ? d.signals : m?.signals ?? [])
  const why = c.fin === 'REVIEW' && m ? modelReason(m) : d.reasons?.[0] ?? null
  const note = d.kind === 'injected_instruction'
    ? Object.values(it.meta ?? {}).find((v) => typeof v === 'string') ?? null
    : null
  return {
    id: c.id.replace(/^(\w+-[0-9a-f]{8})[0-9a-f]*/, '$1'),
    set: d.set,
    src: d.source,
    kind: d.kind,
    action: it.action ?? null,
    asset: it.asset ?? null,
    amt: cut(it.amount, 18),
    exp: d.expected,
    code: d.decision,
    fin: c.fin,
    layer: c.layer ?? null,
    model: m ? (m.risk ?? 'invalid') : null,
    sig: (sig ?? []).slice(0, 4).map((x) => cut(x, 40)),
    why: cut(why, 150),
    note: cut(note, 90),
    usd: typeof d.usd === 'number' ? r2(d.usd) : null,
    code_us: r2(((d.latency_ms?.A ?? 0) + (d.latency_ms?.B ?? 0)) * 1000),
    model_ms: m && typeof m.latency_ms === 'number' ? Math.round(m.latency_ms) : null,
    dg: shortDigest(d.tx_digest),
  }
})

/* Stream composition per (set, final) bucket, so the page can scale counters to the real totals. */
const buckets = {}
for (const s of SETS) for (const f of ['ALLOW', 'REVIEW', 'BLOCK']) {
  const total = sets[s].final[f], shown = events.filter((e) => e.set === s && e.fin === f).length
  if (total || shown) buckets[`${s}|${f}`] = { total, shown }
}

const result = {
  source: { dir: basename(dir), live, snapshot_at: lastTs || summary.updated_at || null, summary_updated_at: summary.updated_at ?? null, done: summary.done ?? null, exported_at: new Date().toISOString(), seed: SEED, skipped_partial_lines: bad },
  totals: {
    cases: cases.length,
    sets,
    latency: { code_p50_us: r2(median(allCode) * 1000), model_p50_ms: r2(median(allModel)), model_n: allModel.length },
    model: { done: cases.filter((c) => c.m).length, policy: summary.model_policy ?? null },
  },
  buckets,
  events,
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(result))

/* ── report ───────────────────────────────────────────────────────── */
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '—')
const ar = sets.attack_real_tx, ac = sets.attack_constructed
console.log(`read ${dir}${bad ? ` (${bad} partial lines skipped)` : ''}`)
console.log(`cases ${cases.length} · snapshot ${result.source.snapshot_at}`)
console.log(`real_traffic ${rt.cases}: false blocks ${rt.fp} · code-only ALLOW ${pct(rt.code_only.ALLOW, rt.cases)} · final ALLOW ${rt.final.ALLOW} (${pct(rt.final.ALLOW, rt.cases)}) / REVIEW ${rt.final.REVIEW} (${pct(rt.final.REVIEW, rt.cases)}) · model reached ${pct(rt.model_done, rt.cases)}`)
console.log(`attack_real_tx blocked ${ar.final.BLOCK}/${ar.expected.BLOCK} · US$ ${ar.usd.attack_blocked}`)
console.log(`attack_constructed attacks blocked ${ac.final.BLOCK}/${ac.expected.BLOCK} · twins allowed ${ac.final.ALLOW}/${ac.expected.ALLOW}`)
console.log(`latency code p50 ${result.totals.latency.code_p50_us} µs · model p50 ${result.totals.latency.model_p50_ms} ms`)
const kinds = {}
for (const e of events) kinds[`${e.set}:${e.kind}`] = (kinds[`${e.set}:${e.kind}`] ?? 0) + 1
console.log(`stream ${events.length} events → ${out}`)
console.log(Object.entries(kinds).sort().map(([k, v]) => `  ${k} ${v}`).join('\n'))
