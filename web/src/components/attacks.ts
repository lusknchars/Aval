/*
 * Attacks the Veto engine stops, with the rule that fires and its real
 * severity (src/evaluation/*.ts): critical findings deny on their own; a high
 * finding holds the transaction (flag), and two highs deny.
 */
export interface Attack {
  title: string
  mark: string
  rule: string
  verdict: 'DENY' | 'FLAG'
  what: string
}

export const ATTACKS: Attack[] = [
  { title: 'Drain to a fresh wallet', mark: '98%', rule: 'provenance.unexplained', verdict: 'DENY', what: 'Funds sent to an address nobody mentioned: not the user, not anything the agent read.' },
  { title: 'Prompt-injected recipient', mark: '{!}', rule: 'provenance.untrusted_source', verdict: 'DENY', what: 'An address planted in an email or web page the agent read, then paid.' },
  { title: 'Unlimited approval', mark: '∞', rule: 'mustNot.DELEGATE_GRANT', verdict: 'DENY', what: 'A delegate quietly granted control of every token in the account.' },
  { title: 'Authority takeover', mark: 'AUTH', rule: 'mustNot.AUTHORITY_CHANGE', verdict: 'DENY', what: 'Mint or freeze authority handed to someone else.' },
  { title: 'Owner reassignment', mark: 'OWN', rule: 'mustNot.OWNER_CHANGE', verdict: 'DENY', what: 'The token account itself moved to a new owner.' },
  { title: 'Deny-listed address', mark: '⊘', rule: 'denylist.address', verdict: 'DENY', what: 'A known-bad address a person already blocked in review.' },
  { title: 'Poisoned source', mark: 'SRC', rule: 'content.labelled_source', verdict: 'DENY', what: 'The instruction came from content labelled as hostile.' },
  { title: 'Blind transaction', mark: '???', rule: 'coverage.simulation_unavailable', verdict: 'DENY', what: 'It cannot be simulated, so it is never a silent allow.' },
  { title: 'Amount inflation', mark: '×10', rule: 'magnitude.above_declared', verdict: 'FLAG', what: 'Moves more than the agent said it would. Held; with a second high finding, denied.' },
  { title: 'Fee drain', mark: 'FEE', rule: 'magnitude.fee_above_ceiling', verdict: 'FLAG', what: 'A priority fee far above the ceiling. Held for a person.' },
]

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/** Square poster for one attack, as a data URL, in the given theme. */
export function poster(a: Attack, index: number, dark: boolean): string {
  const S = 900, L = 225 // draw the dither at quarter resolution, scale up crisp
  const lo = document.createElement('canvas'); lo.width = L; lo.height = L
  const lc = lo.getContext('2d')!
  const img = lc.createImageData(L, L)
  const bg = dark ? [8, 8, 10] : [242, 242, 239]
  const tint = a.verdict === 'DENY' ? (dark ? [255, 59, 47] : [224, 38, 26]) : (dark ? [255, 176, 32] : [194, 122, 0])
  const seed = index * 1.7
  for (let y = 0; y < L; y++) for (let x = 0; x < L; x++) {
    const nx = x / L - 0.5, ny = y / L - 0.5
    // A soft glow with a slow wave through it, dithered to two tones.
    const r = Math.hypot(nx * 1.1, ny)
    let v = Math.max(0, 1 - r * 1.9)
    v *= 0.75 + 0.25 * Math.sin((nx * 9 + ny * 5) + seed)
    v = Math.pow(v, 1.4)
    const on = v * 16 > BAYER[(y % 4) * 4 + (x % 4)] + 0.5
    const k = (y * L + x) * 4
    const c = on ? tint : bg
    const mix = on ? 0.55 : 1
    img.data[k] = c[0] * mix + bg[0] * (1 - mix)
    img.data[k + 1] = c[1] * mix + bg[1] * (1 - mix)
    img.data[k + 2] = c[2] * mix + bg[2] * (1 - mix)
    img.data[k + 3] = 255
  }
  lc.putImageData(img, 0, 0)

  const cv = document.createElement('canvas'); cv.width = S; cv.height = S
  const c = cv.getContext('2d')!
  c.imageSmoothingEnabled = false
  c.drawImage(lo, 0, 0, S, S)
  const ink = dark ? '#f1f1f3' : '#0d0d0c'
  const dim = dark ? 'rgba(241,241,243,.55)' : 'rgba(13,13,12,.55)'
  const accent = `rgb(${tint.join(',')})`
  // scanlines
  c.fillStyle = dark ? 'rgba(255,255,255,.03)' : 'rgba(0,0,0,.03)'
  for (let y = 0; y < S; y += 4) c.fillRect(0, y, S, 1)

  c.textBaseline = 'middle'; c.textAlign = 'center'
  c.fillStyle = ink
  const size = a.mark.length > 3 ? 210 : a.mark.length > 2 ? 250 : 330
  c.font = `700 ${size}px "Chakra Petch", "JetBrains Mono", system-ui, sans-serif`
  c.fillText(a.mark, S / 2, S / 2 + 10)

  c.textAlign = 'left'; c.textBaseline = 'top'
  c.font = `500 28px "JetBrains Mono", ui-monospace, monospace`
  c.fillStyle = dim
  c.fillText(String(index + 1).padStart(2, '0'), 48, 48)
  c.fillText(a.rule, 48, S - 84)

  // verdict stamp, top right
  c.save()
  c.translate(S - 60, 70); c.rotate(-0.06)
  c.font = `700 40px "Chakra Petch", system-ui, sans-serif`
  const w = c.measureText(a.verdict).width + 36
  c.strokeStyle = accent; c.lineWidth = 5
  c.strokeRect(-w, -26, w, 58)
  c.fillStyle = accent; c.textAlign = 'right'; c.textBaseline = 'middle'
  c.fillText(a.verdict, -18, 4)
  c.restore()
  return cv.toDataURL('image/png')
}
