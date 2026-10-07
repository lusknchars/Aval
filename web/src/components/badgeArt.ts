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

/** EMV-style chip, drawn in outline. */
function chip(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const g = ctx.createLinearGradient(x, y, x + 120, y + 90)
  g.addColorStop(0, '#d8d4c8'); g.addColorStop(.5, '#8f8a7e'); g.addColorStop(1, '#cfc9ba')
  ctx.fillStyle = g; ctx.beginPath(); ctx.roundRect(x, y, 120, 90, 14); ctx.fill()
  ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x + 40, y); ctx.lineTo(x + 40, y + 90); ctx.moveTo(x + 80, y); ctx.lineTo(x + 80, y + 90)
  ctx.moveTo(x, y + 30); ctx.lineTo(x + 40, y + 30); ctx.moveTo(x, y + 60); ctx.lineTo(x + 40, y + 60)
  ctx.moveTo(x + 80, y + 30); ctx.lineTo(x + 120, y + 30); ctx.moveTo(x + 80, y + 60); ctx.lineTo(x + 120, y + 60)
  ctx.stroke()
}

/** Three arcs: the "always listening" mark. */
function signal(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.strokeStyle = color; ctx.lineWidth = 6; ctx.lineCap = 'round'
  for (let i = 1; i <= 3; i++) { ctx.beginPath(); ctx.arc(x, y, i * 18, -Math.PI / 4, Math.PI / 4); ctx.stroke() }
}

export async function drawFront() {
  await fontsReady()
  const [c, ctx] = canvas()
  const bg = ctx.createLinearGradient(0, 0, W, H)
  bg.addColorStop(0, '#16151b'); bg.addColorStop(.55, '#0b0a0e'); bg.addColorStop(1, '#1b1a21')
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); grid(ctx)
  try { const logo = await loadImg('/brand/aval-lockup-dark.svg'); ctx.drawImage(logo, 56, 64, 300, 300 * 535 / 1195) } catch { /* text only */ }
  ctx.font = `400 20px ${MONO}`; ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.textAlign = 'right'
  ctx.fillText('TRANSACTION', W - 64, 118); ctx.fillText('SECURITY CARD', W - 64, 146); ctx.textAlign = 'left'
  chip(ctx, 64, 300)
  signal(ctx, 230, 345, 'rgba(255,255,255,.75)')
  ctx.font = `700 92px ${DISPLAY}`; ctx.fillStyle = '#ffffff'
  ctx.fillText('PROTECTED', 58, 540)
  ctx.font = `400 22px ${MONO}`; ctx.fillStyle = 'rgba(255,255,255,.6)'
  ctx.fillText('judged before it signs · watched 24/7', 64, 586)
  ctx.font = `400 40px ${MONO}`; ctx.fillStyle = '#ececec'
  ctx.fillText('AVAL  ••••  ••••  0007', 64, 690)
  rows(ctx, 790, [
    ['holder', 'treasury-07'],
    ['network', 'solana · mainnet'],
    ['valid', 'every signature'],
  ])
  stamp(ctx, 64, 1060, 'ARMED', '#3ddc84', false)
  ctx.font = `400 20px ${MONO}`; ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.textAlign = 'right'
  ctx.fillText('ON-CHAIN GUARD', W - 64, 1046); ctx.textAlign = 'left'
  return c.toDataURL('image/png')
}

export async function drawBack() {
  await fontsReady()
  const [c, ctx] = canvas()
  ctx.fillStyle = '#0b0a0e'; ctx.fillRect(0, 0, W, H)
  // Stripe, like the back of a bank card.
  ctx.fillStyle = '#000'; ctx.fillRect(0, 80, W, 120)
  grid(ctx)
  ctx.font = `400 20px ${MONO}`; ctx.fillStyle = 'rgba(255,255,255,.5)'
  ctx.fillText('LAST VERDICT · RECEIPT #36095417', 64, 280)
  stamp(ctx, 64, 410, 'VETO', '#ff3b2f', true)
  ctx.font = `600 50px ${DISPLAY}`; ctx.fillStyle = '#ffffff'
  ctx.fillText('Drain to a fresh', 64, 530)
  ctx.fillText('wallet, stopped.', 64, 590)
  rows(ctx, 690, [
    ['action', 'transfer 98% → 9xQe…'],
    ['rule', 'provenance.unexplained'],
    ['decided in', '0.50 ms · warm'],
  ])
  signal(ctx, 74, 960, '#3ddc84')
  ctx.font = `600 34px ${DISPLAY}`; ctx.fillStyle = '#ececec'
  ctx.fillText('Monitoring 24/7', 150, 972)
  ctx.font = `400 18px ${MONO}`; ctx.fillStyle = 'rgba(255,255,255,.35)'
  ctx.fillText('AVAL · BUILT FOR VETO · SUPERTEAM BRASIL 2026', 64, 1068)
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
