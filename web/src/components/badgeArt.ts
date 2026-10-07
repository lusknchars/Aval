/*
 * Art for the footer lanyard, drawn at runtime in the site's own fonts:
 * an AVAL "agent pass" for the card's front, the veto it issued for the
 * back, and the strap texture. The agent and the transactions are the same
 * demo identities the verdicts feed shows.
 */
const W = 800, H = 1130

const MONO = '"Martian Mono", ui-monospace, monospace'
const DISPLAY = '"Chakra Petch", system-ui, sans-serif'

const loadImg = (src: string) => new Promise<HTMLImageElement>((ok, fail) => {
  const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src
})

async function fontsReady() {
  try {
    await Promise.all([
      document.fonts.load(`700 120px ${DISPLAY}`),
      document.fonts.load(`600 40px ${DISPLAY}`),
      document.fonts.load(`400 24px ${MONO}`),
      document.fonts.load(`700 24px ${MONO}`),
    ])
  } catch { /* fall back to system faces */ }
}

function canvas(w = W, h = H) {
  const c = document.createElement('canvas'); c.width = w; c.height = h
  return [c, c.getContext('2d')!] as const
}

function grid(ctx: CanvasRenderingContext2D) {
  ctx.strokeStyle = 'rgba(255,255,255,.045)'; ctx.lineWidth = 1
  for (let x = 0; x <= W; x += 40) { ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, H); ctx.stroke() }
  for (let y = 0; y <= H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(W, y + .5); ctx.stroke() }
}

function rows(ctx: CanvasRenderingContext2D, y: number, list: [string, string][]) {
  ctx.font = `400 22px ${MONO}`
  for (const [k, v] of list) {
    ctx.fillStyle = 'rgba(255,255,255,.45)'; ctx.fillText(k.toUpperCase(), 64, y)
    ctx.fillStyle = '#ececec'; ctx.fillText(v, 300, y)
    ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.setLineDash([4, 6]); ctx.beginPath(); ctx.moveTo(64, y + 22); ctx.lineTo(W - 64, y + 22); ctx.stroke(); ctx.setLineDash([])
    y += 62
  }
  return y
}

function stamp(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, color: string, filled: boolean) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(-0.035)
  ctx.font = `700 64px ${DISPLAY}`
  const w = ctx.measureText(label).width + 56
  if (filled) { ctx.fillStyle = color; ctx.fillRect(0, -62, w, 84); ctx.fillStyle = '#0b0a0e' }
  else { ctx.strokeStyle = color; ctx.lineWidth = 5; ctx.strokeRect(0, -62, w, 84); ctx.fillStyle = color }
  ctx.fillText(label, 28, 2)
  ctx.restore()
}

export async function drawFront() {
  await fontsReady()
  const [c, ctx] = canvas()
  ctx.fillStyle = '#0b0a0e'; ctx.fillRect(0, 0, W, H); grid(ctx)
  try { const logo = await loadImg('/brand/aval-lockup-dark.svg'); ctx.drawImage(logo, 56, 70, 300, 300 * 535 / 1195) } catch { /* text only */ }
  ctx.font = `400 20px ${MONO}`; ctx.fillStyle = 'rgba(255,255,255,.5)'
  ctx.fillText('AGENT PASS · Nº 0007', 64, 268)
  ctx.font = `700 104px ${DISPLAY}`; ctx.fillStyle = '#ffffff'
  ctx.fillText('treasury-07', 58, 372)
  ctx.font = `400 24px ${MONO}`; ctx.fillStyle = 'rgba(255,255,255,.6)'
  ctx.fillText('autonomous agent · holds a wallet', 64, 420)
  rows(ctx, 520, [
    ['network', 'solana · mainnet'],
    ['wallet', '7xKp…4fQe'],
    ['manifest', 'swap · pay · stake'],
    ['spend cap', '500 USDC / day'],
    ['gate', 'aval · local sim'],
  ])
  stamp(ctx, 64, 930, 'ARMED', '#3ddc84', false)
  ctx.font = `400 20px ${MONO}`; ctx.fillStyle = 'rgba(255,255,255,.45)'
  ctx.fillText('every transaction judged before it signs', 64, 1050)
  return c.toDataURL('image/png')
}

export async function drawBack() {
  await fontsReady()
  const [c, ctx] = canvas()
  ctx.fillStyle = '#0b0a0e'; ctx.fillRect(0, 0, W, H); grid(ctx)
  ctx.font = `400 20px ${MONO}`; ctx.fillStyle = 'rgba(255,255,255,.5)'
  ctx.fillText('LAST VERDICT · RECEIPT #36095417', 64, 110)
  stamp(ctx, 64, 270, 'VETO', '#ff3b2f', true)
  ctx.font = `600 54px ${DISPLAY}`; ctx.fillStyle = '#ffffff'
  ctx.fillText('Drain to a fresh', 64, 400)
  ctx.fillText('wallet, stopped.', 64, 462)
  rows(ctx, 570, [
    ['agent', 'trader-3'],
    ['action', 'transfer 98% → 9xQe…'],
    ['rule', 'provenance.unexplained'],
    ['severity', 'critical'],
    ['decided in', '0.50 ms · warm'],
  ])
  ctx.font = `400 20px ${MONO}`; ctx.fillStyle = 'rgba(255,255,255,.45)'
  ctx.fillText('held before the signature · nothing landed', 64, 960)
  ctx.fillStyle = 'rgba(255,255,255,.3)'
  ctx.fillText('AVAL · BUILT FOR VETO · SUPERTEAM BRASIL 2026', 64, 1050)
  return c.toDataURL('image/png')
}

/** Strap: a light band (it hangs on a dark screen), the wordmark repeated. */
export async function drawStrap() {
  await fontsReady()
  const [c, ctx] = canvas(1024, 256)
  ctx.fillStyle = '#ececec'; ctx.fillRect(0, 0, 1024, 256)
  ctx.fillStyle = '#0b0a0e'; ctx.font = `700 120px ${DISPLAY}`; ctx.textBaseline = 'middle'
  ctx.fillText('AVAL', 70, 132)
  ctx.font = `400 44px ${MONO}`; ctx.fillStyle = 'rgba(11,10,14,.55)'
  ctx.fillText('· VETO ·', 470, 132)
  ctx.fillStyle = '#ff3b2f'; ctx.fillRect(860, 108, 48, 48)
  return c.toDataURL('image/png')
}
