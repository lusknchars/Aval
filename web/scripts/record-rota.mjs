#!/usr/bin/env node
/*
 * Record the engine's verdict for every job in the Live gate's rota
 * (src/app/config/rota.ts), with that job's exact request, into
 * src/app/snapshots/rota/<job id>.json. The public demo replays these.
 *
 *   node scripts/record-rota.mjs                 # engine at http://127.0.0.1:5173
 *   VETO_URL=http://host:port node scripts/record-rota.mjs
 *
 * Refuses to write a recording that carries a key, an RPC URL or a local path.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROTA } from '../src/app/config/rota.ts'

const VETO = process.env.VETO_URL ?? 'http://127.0.0.1:5173'
const OUT = join(import.meta.dirname, '../src/app/snapshots/rota')
const SECRET = /api-key|api_key|helius|\/Users\/|\/private\/tmp|\/home\/|rpc\.[a-z.]+\/\?|[?&]key=/i

mkdirSync(OUT, { recursive: true })
const recordedAt = new Date().toISOString()
let failed = 0
for (const job of ROTA) {
  const t0 = performance.now()
  const res = await fetch(`${VETO}/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(job.req) })
  const ms = Math.round((performance.now() - t0) * 100) / 100
  const trace = await res.json()
  if (!res.ok || trace.error) { console.error(`${job.id}: engine said ${res.status} ${trace.error ?? ''}`); failed++; continue }
  const body = JSON.stringify({ id: job.id, recordedAt, engine: 'AVAL engine (Veto demo server, POST /evaluate)', request: job.req, ms, trace }, null, 1) + '\n'
  const hit = body.match(SECRET)
  if (hit) { console.error(`${job.id}: recording contains "${hit[0]}", not written`); failed++; continue }
  writeFileSync(join(OUT, `${job.id}.json`), body)
  console.log(`${job.id.padEnd(28)} ${trace.decision.outcome.toUpperCase().padEnd(5)} ${String(ms).padStart(8)} ms  ${trace.decision.steps.find((s) => s.held)?.rule ?? ''}`)
}
process.exit(failed ? 1 : 0)
