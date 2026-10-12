import { useEffect, useSyncExternalStore } from 'react'
import { fixtureHealth, ping } from './api'

/* Whether the Veto demo server answers through the proxy, re-checked every 10 s.
   'no-fixtures': it answers, but can't read its fixture transactions, so
   evaluations fall back to recorded verdicts (see api.evaluate). */
type State = 'checking' | 'live' | 'offline' | 'no-fixtures'
let state: State = 'checking'
const subs = new Set<() => void>()
let timer = 0

async function check() {
  const next = (await ping()) ? 'live' : 'offline'
  if (next !== state) { state = next; subs.forEach((f) => f()) }
}

export function useEngine() {
  useEffect(() => {
    if (!timer) { check(); timer = window.setInterval(check, 10_000) }
  }, [])
  const s = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, () => state)
  const missing = useSyncExternalStore(fixtureHealth.subscribe, fixtureHealth.missing)
  return s === 'live' && missing ? 'no-fixtures' : s
}
