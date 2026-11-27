// Text for the glasses. The G2 shows 576x288 monochrome green with one
// firmware font (not monospaced, no sizes), so every card is three blocks:
// a dim header, a body of at most five short lines, and a dim footer that
// always says what tap / hold / swipe will do right now.

export function px(n) {
  if (!Number.isFinite(n)) return 'n/a'
  const a = Math.abs(n)
  if (a >= 1000) return n.toFixed(a >= 10000 ? 0 : 1)
  if (a >= 10) return n.toFixed(2)
  if (a >= 1) return n.toFixed(3)
  return Number(n.toPrecision(4)).toString()
}

export const usd = (n) => (n < 0 ? '−$' : '+$') + Math.abs(n).toFixed(2)
export const rr = (n) => (n < 0 ? '−' : '+') + Math.abs(n).toFixed(2) + 'R'
const arrow = (side) => (side === 'long' ? '▲ LONG' : '▼ SHORT')
/** Display name of a coin; Binance already lists PEPE as 1000PEPE. */
export const name = (coin) => coin.replace(/^k(?=[A-Z])/, '1000')
const range = (e) => (e.lo === e.hi ? px(e.lo) : `${px(e.lo)}-${px(e.hi)}`)
const isDemo = (p) => p.venue === 'binance-demo'

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

/** The caller's report card in one line: how often TP1 came before the stop, and the average R. */
export function record(score) {
  const closed = score ? score.wins + score.losses : 0
  if (!closed) return score?.calls > 1 ? `Caller: ${score.calls} calls, none closed yet` : 'Caller: no track record yet'
  return `Caller: ${score.wins} of ${closed} hit TP1 first, avg ${rr(score.avgR ?? score.totalR / closed)}`
}

/** Progress of price between stop and target: SL ───●─── TP */
export function bar(sl, tp, mid, width = 12) {
  if (![sl, tp, mid].every(Number.isFinite) || sl === tp) return ''
  const f = Math.min(1, Math.max(0, (mid - sl) / (tp - sl)))
  const i = Math.round(f * (width - 1))
  return '─'.repeat(i) + '●' + '─'.repeat(width - 1 - i)
}

export function callCard(call, { mid, score, size, now, pos, label = 'paper' }) {
  const t = call.ticket
  const late = lateNote(t, mid)
  return {
    header: `NEW CALL · ${call.source} · ${ago(now - call.postedAt)}${pos}`,
    body: [
      `${arrow(t.side)} ${name(t.coin)}${t.leverage ? `  ${t.leverage}x` : ''}`,
      record(score),
      `Entry ${t.entry ? range(t.entry) : 'market'}   SL ${px(t.sl)}`,
      `TP ${t.tps.slice(0, 3).map(px).join(' · ')}`,
      `Now ${px(mid)}   ${late ? `${late}, too late` : zoneNote(t, mid)}`,
    ].join('\n'),
    footer: late ? `too late to take      hold  speak      swipe  next` : `tap  ${label} $${size}      hold  speak      swipe  next`,
  }
}

export function confirmCard(preview, call, label = 'paper') {
  const demo = label === 'demo'
  const lines = [
    `${arrow(preview.side)} ${name(preview.coin)}   $${preview.sizeUsd} at ${px(preview.entry)}`,
    `Stop ${px(preview.sl)}    if hit  ${usd(-preview.risk)}`,
    `TP1  ${px(preview.tp)}    if hit  ${usd(preview.reward)}`,
  ]
  if (preview.chasePct) lines.push(`Chasing: ${preview.chasePct}% past the caller's zone`)
  else if (preview.minNote) lines.push(`Size ${preview.minNote}`)
  lines.push(demo ? `Binance demo order, stop and TP1 set on Binance.` : `Paper trade from ${call.source}. No real funds.`)
  return {
    header: demo ? 'CONFIRM BINANCE DEMO ORDER' : 'CONFIRM PAPER TRADE',
    body: lines.join('\n'),
    footer: 'tap  confirm      swipe  cancel      hold  say a size',
  }
}

export function positionCard(p, { mid, pnl, now, pos }) {
  const progress = p.side === 'long' ? bar(p.sl, p.tp, mid) : bar(-p.sl, -p.tp, -mid)
  return {
    header: `${isDemo(p) ? 'BINANCE DEMO' : 'PAPER POSITION'} · ${p.source}${pos}`,
    body: [
      `${arrow(p.side)} ${name(p.coin)}   $${p.sizeUsd} at ${px(p.entry)}`,
      pnl ? `Now ${px(mid)}    ${usd(pnl.usd)}   ${rr(pnl.r)}` : `Now ${px(mid)}`,
      `SL ${px(p.sl)}  ${progress}  TP ${px(p.tp)}`,
      p.note ? p.note : `Opened ${ago(now - p.openedAt)}${isDemo(p) ? ', stop and TP1 on Binance' : ''}`,
    ].join('\n'),
    footer: 'tap  close      hold  speak      swipe  next',
  }
}

export function closeCard(p, { mid, pnl }) {
  return {
    header: isDemo(p) ? 'CLOSE AT MARKET ON BINANCE DEMO?' : 'CLOSE PAPER POSITION?',
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
    ? top.map((s, i) => `${i + 1}. ${s.source.slice(0, 22)}   ${s.wins}/${s.wins + s.losses} TP1   avg ${rr(s.avgR)}`).join('\n')
    : 'No closed calls yet.\nForward a caller\'s old calls to the bot\nand they are graded on Binance candles.'
  return {
    header: `CALLER SCORES · ${graded} calls graded${pos}`,
    body,
    footer: 'tap  post to Telegram      swipe  next',
  }
}

export function idleCard({ chats, last, venue }) {
  return {
    header: 'CALLEDIT',
    body: [
      `Watching ${chats} Telegram chat${chats === 1 ? '' : 's'}.`,
      'No open calls right now.',
      last ? `Last: ${last}` : 'Calls show up here the moment they are posted.',
      ...(venue ? [venue] : []),
    ].join('\n'),
    footer: 'hold  speak      swipe  scores',
  }
}

/** Short reason a position closed, for the flash line and the journal. */
export function closeWhy(reason) {
  switch (reason) {
    case 'stop': return 'Stop hit'
    case 'tp1': return 'TP1 hit'
    case 'binance': return 'Closed on Binance'
    case 'safety': return 'Closed, stop order refused'
    default: return 'Closed from G2'
  }
}

// ---- Telegram journal lines -------------------------------------------------

export function journalOpen(p) {
  const risk = p.qty * Math.abs(p.entry - p.sl)
  return [
    `📓 ${isDemo(p) ? 'Binance demo' : 'Paper'} ${p.side.toUpperCase()} ${name(p.coin)} $${p.sizeUsd} @ ${px(p.entry)}`,
    `SL ${px(p.sl)} · TP1 ${px(p.tp)} · risk ${usd(-risk)}`,
    `Call from ${p.source} · tapped on Even G2`,
  ].join('\n')
}

export function journalClose(p, pnl) {
  const icon = p.closeReason === 'stop' ? '🛑' : p.closeReason === 'tp1' ? '✅' : p.closeReason === 'safety' ? '⚠️' : '↩️'
  const why = closeWhy(p.closeReason).replace(/^(Stop|Closed)/, (w) => w.toLowerCase())
  const venue = isDemo(p) ? ' (Binance demo)' : ''
  return `${icon} ${name(p.coin)} ${p.side} ${why} @ ${px(p.exit)}  ${usd(pnl?.usd ?? 0)} (${rr(pnl?.r ?? 0)})${venue}\nCall from ${p.source}`
}

export function journalScores(scores) {
  const rows = scores.slice(0, 10).map((s, i) => {
    const closed = s.wins + s.losses
    if (!closed) return `${i + 1}. ${s.source}: no closed calls yet, ${s.open} open`
    return `${i + 1}. ${s.source}: ${s.wins} of ${closed} hit TP1 first (${Math.round(s.winRate * 100)}%), avg ${rr(s.avgR)}, total ${rr(s.totalR)}, ${s.open} open`
  })
  return ['🏁 Caller scores (TP1 before the stop, Binance futures candles)', ...rows].join('\n')
}

export function describeTicket(t) {
  return `${t.side.toUpperCase()} ${name(t.coin)} · entry ${t.entry ? range(t.entry) : 'market'} · SL ${px(t.sl)} · TP ${t.tps.map(px).join(' / ')}`
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
