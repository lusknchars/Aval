import { useSyncExternalStore } from 'react'
import type { Entry } from './types'
import { FIXTURES, SNAPSHOT_TRACES } from './fixtures'

/*
 * The console's action log: every evaluation run from this browser. Kept in
 * localStorage so a reload keeps the session; storage can be unavailable
 * (private windows), in which case the log just lives in memory.
 */
// v2: entries now carry Cerrado Capital's agents; v1 held the old generic rota.
const KEY = 'aval.console.entries.v2'
const MAX = 60

function seed(): Entry[] {
  // First visit: one recorded verdict per fixture so the console is not empty.
  const now = Date.now()
  return FIXTURES.map((f, i) => ({
    id: `seed-${f.name}`,
    at: now - (FIXTURES.length - i) * 97_000,
    request: { goal: 'pay the supplier invoice', fixture: f.name, provenance: 'retrieved' as const },
    trace: SNAPSHOT_TRACES[f.name],
    source: 'snapshot' as const,
    ms: 0,
  })).reverse()
}

function load(): Entry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* storage blocked */ }
  return seed()
}

let entries: Entry[] = load()
const subs = new Set<() => void>()

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(entries)) } catch { /* storage blocked */ }
  subs.forEach((f) => f())
}

export const store = {
  add(e: Entry) { entries = [e, ...entries].slice(0, MAX); save() },
  get(id: string) { return entries.find((e) => e.id === id) },
  clear() { entries = seed(); save() },
}

export function useEntries() {
  return useSyncExternalStore(
    (f) => { subs.add(f); return () => subs.delete(f) },
    () => entries,
  )
}
