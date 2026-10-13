import { useEffect, useSyncExternalStore } from 'react'
import { fixtureHealth, ping } from './api'
import { DEMO } from '../demo'

/* Whether the Veto demo server answers through the proxy, re-checked every 10 s.
   'no-fixtures': it answers, but can't read its fixture transactions, so
   evaluations fall back to recorded verdicts (see api.evaluate).
   'recorded': the public demo build, which has no engine and never checks. */
type State = 'checking' | 'live' | 'offline' | 'no-fixtures' | 'recorded'
let state: State = DEMO ? 'recorded' : 'checking'
const subs = new Set<() => void>()
let timer = 0

async function check() {
  const next = (await ping()) ? 'live' : 'offline'
  if (next !== state) { state = next; subs.forEach((f) => f()) }
}

export function useEngine() {
  useEffect(() => {
    if (!timer && !DEMO) { check(); timer = window.setInterval(check, 10_000) }
  }, [])
  const s = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, () => state)
  const missing = useSyncExternalStore(fixtureHealth.subscribe, fixtureHealth.missing)
  return s === 'live' && missing ? 'no-fixtures' : s
}
