// Grades a call against what the market actually did after it was posted.
//
// A call "worked" when TP1 traded before the stop, after the entry was
// reachable. Everything is measured in R (multiples of the risk the caller
// defined): +1.6R means TP1 paid 1.6x the distance to the stop.
//
// Conservative by design: when one candle spans both the stop and the target
// we cannot know which came first, so it counts as a loss.

export const FILL_WINDOW_MS = 48 * 3_600_000

/**
 * @param {object} ticket  parsed call (side, entry|null, sl, tps)
 * @param {number} postedAt  ms timestamp of the original post
 * @param {Array<{t:number,o:number,h:number,l:number,c:number}>} candles  ascending
 * @param {number} now
 */
export function gradeCall(ticket, postedAt, candles, now = Date.now()) {
  const long = ticket.side === 'long'
  const tp = ticket.tps[0]
  const { sl } = ticket
  let fill = null
  let fillAt = null

  // `candles` must start at the post (see candlesSince): nothing before it counts.
  for (const k of candles) {
    if (fill === null) {
      if (k.t - postedAt > FILL_WINDOW_MS) return { status: 'expired', at: k.t }
      if (!ticket.entry) {
        fill = k.o
      } else {
        const { lo, hi } = ticket.entry
        if (k.l > hi || k.h < lo) continue // zone not reached in this candle
        // A resting limit order: a long buys at the zone top or better, a short sells at the bottom or better.
        fill = long ? Math.min(k.o, hi) : Math.max(k.o, lo)
      }
      fillAt = k.t
    }
    const hitSl = long ? k.l <= sl : k.h >= sl
    const hitTp = long ? k.h >= tp : k.l <= tp
    if (hitSl) return closed('sl', sl, k.t, hitTp)
    if (hitTp) return closed('tp', tp, k.t, false)
  }

  if (fill === null) {
    return now - postedAt > FILL_WINDOW_MS ? { status: 'expired', at: now } : { status: 'waiting' }
  }
  const last = candles[candles.length - 1]?.c
  return { status: 'open', fill, fillAt, r: rMultiple(last) }

  function rMultiple(exit) {
    const risk = Math.abs(fill - sl)
    if (!risk) return 0
    return round2(((long ? exit - fill : fill - exit) / risk))
  }
  function closed(status, exit, at, ambiguous) {
    return { status, fill, fillAt, exit, exitAt: at, r: rMultiple(exit), ...(ambiguous ? { ambiguous: true } : {}) }
  }
}

export const round2 = (n) => Math.round(n * 100) / 100

/** Per-source track record from graded calls. */
export function scoreboard(calls) {
  const by = new Map()
  for (const c of calls) {
    if (!c.ticket || c.ticket.invalid) continue
    const s = by.get(c.source) ?? { source: c.source, calls: 0, wins: 0, losses: 0, open: 0, waiting: 0, expired: 0, totalR: 0 }
    s.calls++
    const g = c.grade?.status
    if (g === 'tp') { s.wins++; s.totalR += c.grade.r }
    else if (g === 'sl') { s.losses++; s.totalR += c.grade.r }
    else if (g === 'open') s.open++
    else if (g === 'expired') s.expired++
    else s.waiting++
    by.set(c.source, s)
  }
  return [...by.values()]
    .map((s) => {
      const closedN = s.wins + s.losses
      return { ...s, totalR: round2(s.totalR), winRate: closedN ? s.wins / closedN : null, avgR: closedN ? round2(s.totalR / closedN) : null }
    })
    .sort((a, b) => b.totalR - a.totalR || b.calls - a.calls)
}
