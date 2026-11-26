// Text for the glasses. The G2 shows 576x288 monochrome green with one
// firmware font (not monospaced, no sizes), so every card is three blocks:
// a dim header, a body of at most five short lines, and a dim footer that
// always says what tap / hold / swipe will do right now.

export function px(n) {
  if (!Number.isFinite(n)) return '–'
  const a = Math.abs(n)
  if (a >= 1000) return n.toFixed(a >= 10000 ? 0 : 1)
  if (a >= 10) return n.toFixed(2)
  if (a >= 1) return n.toFixed(3)
  return Number(n.toPrecision(4)).toString()
}

export const usd = (n) => (n < 0 ? '−$' : '+$') + Math.abs(n).toFixed(2)
export const rr = (n) => (n < 0 ? '−' : '+') + Math.abs(n).toFixed(2) + 'R'
const arrow = (side) => (side === 'long' ? '▲ LONG' : '▼ SHORT')
const name = (coin) => coin.replace(/^k(?=[A-Z])/, '1000')

export function ago(ms) {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

function zoneNote(t, mid) {
  if (!Number.isFinite(mid)) return 'no price yet'
  if (!t.entry) return 'market entry'
  const { lo, hi } = t.entry
  if (mid >= lo && mid <= hi) return 'in the entry zone ●'
  const pct = mid > hi ? (mid - hi) / hi : (lo - mid) / lo
  const where = mid > hi ? 'above' : 'below'
  return `${(pct * 100).toFixed(1)}% ${where} the zone`
}

/** A live call that can no longer be taken: price already through the stop or TP1. */
export function lateNote(t, mid) {
  if (!Number.isFinite(mid) || !Number.isFinite(t.sl)) return null
  const long = t.side === 'long'
  if (long ? mid <= t.sl : mid >= t.sl) return 'already past the stop'
  const tp = t.tps?.[0]
  if (Number.isFinite(tp) && (long ? mid >= tp : mid <= tp)) return 'TP1 already hit'
  return null
}

export function record(score) {
  if (!score || score.wins + score.losses === 0) {
    return score?.calls > 1 ? `Caller: ${score.calls} calls, none closed yet` : 'Caller: no track record yet'
  }
  return `Caller: ${score.wins}W ${score.losses}L  ${rr(score.totalR)}`
}

/** Progress of price between stop and target: SL ───●─── TP */
export function bar(sl, tp, mid, width = 12) {
  if (![sl, tp, mid].every(Number.isFinite) || sl === tp) return ''
  const f = Math.min(1, Math.max(0, (mid - sl) / (tp - sl)))
  const i = Math.round(f * (width - 1))
  return '─'.repeat(i) + '●' + '─'.repeat(width - 1 - i)
}

export function callCard(call, { mid, score, size, now, pos }) {
  const t = call.ticket
  const entry = t.entry ? (t.entry.lo === t.entry.hi ? px(t.entry.lo) : `${px(t.entry.lo)}–${px(t.entry.hi)}`) : 'market'
  const late = lateNote(t, mid)
  return {
    header: `NEW CALL · ${call.source} · ${ago(now - call.postedAt)}${pos}`,
    body: [
      `${arrow(t.side)} ${name(t.coin)}${t.leverage ? `  ${t.leverage}x` : ''}`,
      `Entry ${entry}   SL ${px(t.sl)}`,
      `TP ${t.tps.slice(0, 3).map(px).join(' · ')}`,
      `Now ${px(mid)}   ${late ? `${late}, too late` : zoneNote(t, mid)}`,
      record(score),
    ].join('\n'),
    footer: late ? 'too late to paper      hold  speak      swipe  next' : `tap  paper $${size}      hold  speak      swipe  next`,
  }
}

export function confirmCard(preview, call) {
  const lines = [
    `${arrow(preview.side)} ${name(preview.coin)}   $${preview.sizeUsd} at ${px(preview.entry)}`,
    `Stop ${px(preview.sl)}    if hit  ${usd(-preview.risk)}`,
    `TP1  ${px(preview.tp)}    if hit  ${usd(preview.reward)}`,
  ]
  if (preview.chasePct) lines.push(`Chasing: ${preview.chasePct}% past the caller's zone`)
  lines.push(`Paper trade from ${call.source}. No real funds.`)
  return {
    header: 'CONFIRM PAPER TRADE',
    body: lines.join('\n'),
    footer: 'tap  confirm      swipe  cancel      hold  say a size',
  }
}

export function positionCard(p, { mid, pnl, now, pos }) {
  const progress = p.side === 'long' ? bar(p.sl, p.tp, mid) : bar(-p.sl, -p.tp, -mid)
  return {
    header: `PAPER POSITION · ${p.source}${pos}`,
    body: [
      `${arrow(p.side)} ${name(p.coin)}   $${p.sizeUsd} at ${px(p.entry)}`,
      pnl ? `Now ${px(mid)}    ${usd(pnl.usd)}   ${rr(pnl.r)}` : `Now ${px(mid)}`,
      `SL ${px(p.sl)}  ${progress}  TP ${px(p.tp)}`,
      `Opened ${ago(now - p.openedAt)}`,
    ].join('\n'),
    footer: 'tap  close      hold  speak      swipe  next',
  }
}

export function closeCard(p, { mid, pnl }) {
  return {
    header: 'CLOSE PAPER POSITION?',
    body: [
      `${arrow(p.side)} ${name(p.coin)}   $${p.sizeUsd} at ${px(p.entry)}`,
      `Close at ${px(mid)}    ${pnl ? `${usd(pnl.usd)}   ${rr(pnl.r)}` : ''}`,
    ].join('\n'),
    footer: 'tap  close now      swipe  keep it',
  }
}

export function scoreCard(scores, { pos, graded }) {
  const top = scores.filter((s) => s.wins + s.losses > 0).slice(0, 4)
  const body = top.length
    ? top.map((s, i) => `${i + 1}. ${s.source.slice(0, 24)}   ${s.wins}W ${s.losses}L   ${rr(s.totalR)}`).join('\n')
    : 'No closed calls yet.\nForward a caller\'s old calls to the bot\nand they are graded on Hyperliquid.'
  return {
    header: `CALLER SCORES · ${graded} calls graded${pos}`,
    body,
    footer: 'tap  post to Telegram      swipe  next',
  }
}

export function idleCard({ chats, last }) {
  return {
    header: 'CALLEDIT',
    body: [
      `Watching ${chats} Telegram chat${chats === 1 ? '' : 's'}.`,
      'No open calls right now.',
      last ? `Last: ${last}` : 'Calls show up here the moment they are posted.',
    ].join('\n'),
    footer: 'hold  speak      swipe  scores',
  }
}

// ---- Telegram journal lines -------------------------------------------------

export function journalOpen(p, preview) {
  return [
    `📓 Paper ${p.side.toUpperCase()} ${name(p.coin)} $${p.sizeUsd} @ ${px(p.entry)}`,
    `SL ${px(p.sl)} · TP1 ${px(p.tp)} · risk ${usd(-preview.risk)}`,
    `Call from ${p.source} · tapped on Even G2`,
  ].join('\n')
}

export function journalClose(p, pnl) {
  const icon = p.closeReason === 'stop' ? '🛑' : p.closeReason === 'tp1' ? '✅' : '↩️'
  const why = p.closeReason === 'stop' ? 'stop hit' : p.closeReason === 'tp1' ? 'TP1 hit' : 'closed from G2'
  return `${icon} ${name(p.coin)} ${p.side} ${why} @ ${px(p.exit)}  ${usd(pnl.usd)} (${rr(pnl.r)})\nCall from ${p.source}`
}

export function journalScores(scores) {
  const rows = scores.slice(0, 10).map((s, i) => {
    const wr = s.winRate == null ? '–' : `${Math.round(s.winRate * 100)}%`
    return `${i + 1}. ${s.source}: ${s.wins}W ${s.losses}L (${wr}), ${rr(s.totalR)}, ${s.open} open`
  })
  return ['🏁 Caller scores (TP1 before stop, Hyperliquid candles)', ...rows].join('\n')
}

export function describeTicket(t) {
  const entry = t.entry ? (t.entry.lo === t.entry.hi ? px(t.entry.lo) : `${px(t.entry.lo)}–${px(t.entry.hi)}`) : 'market'
  return `${t.side.toUpperCase()} ${name(t.coin)} · entry ${entry} · SL ${px(t.sl)} · TP ${t.tps.map(px).join(' / ')}`
}

export function describeGrade(g) {
  if (!g) return 'not graded yet'
  switch (g.status) {
    case 'tp': return `TP1 hit first: ${rr(g.r)}`
    case 'sl': return `stop hit first: ${rr(g.r)}${g.ambiguous ? ' (stop and TP1 in one candle, counted as a loss)' : ''}`
    case 'open': return `filled at ${px(g.fill)}, still open (${rr(g.r)})`
    case 'waiting': return 'entry not reached yet'
    case 'expired': return 'entry never reached within 48h'
    default: return g.status
  }
}
