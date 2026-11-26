// Paper ledger: the trades the wearer actually took from a call.
// Live mid prices from Hyperliquid, simulated fills, no keys, no funds.

import { round2 } from './grade.js'

export const SIZES = [25, 50, 100, 250]

export class PaperBook {
  constructor(state = {}) {
    this.positions = state.positions ?? []
    this.seq = state.seq ?? 1
    this.maxSize = state.maxSize ?? 250
  }

  toJSON() {
    return { positions: this.positions, seq: this.seq, maxSize: this.maxSize }
  }

  open() {
    return this.positions.filter((p) => p.status === 'open')
  }

  /** Checks a paper entry without opening it. Returns { ok, reason?, preview? }. */
  check(call, sizeUsd, mid) {
    const t = call.ticket
    if (!t || t.invalid) return { ok: false, reason: t?.invalid ?? 'not a call' }
    if (!Number.isFinite(mid)) return { ok: false, reason: `no price for ${t.coin}` }
    if (!(sizeUsd > 0)) return { ok: false, reason: 'size must be positive' }
    if (sizeUsd > this.maxSize) return { ok: false, reason: `size above your $${this.maxSize} cap` }
    const long = t.side === 'long'
    const tp = t.tps[0]
    if (long ? mid <= t.sl : mid >= t.sl) return { ok: false, reason: 'price is already past the stop' }
    if (long ? mid >= tp : mid <= tp) return { ok: false, reason: 'TP1 already hit, too late' }
    if (this.open().some((p) => p.callId === call.id)) return { ok: false, reason: 'already in this call' }
    const qty = sizeUsd / mid
    const risk = qty * Math.abs(mid - t.sl)
    const reward = qty * Math.abs(tp - mid)
    let chase = null
    if (t.entry) {
      const away = long ? (mid - t.entry.hi) / t.entry.hi : (t.entry.lo - mid) / t.entry.lo
      if (away > 0.001) chase = round2(away * 100)
    }
    return {
      ok: true,
      preview: { side: t.side, coin: t.coin, sizeUsd, entry: mid, sl: t.sl, tp, risk: round2(risk), reward: round2(reward), chasePct: chase },
    }
  }

  openFromCall(call, sizeUsd, mid, now = Date.now()) {
    const c = this.check(call, sizeUsd, mid)
    if (!c.ok) return c
    const t = call.ticket
    const pos = {
      id: `P${this.seq++}`,
      callId: call.id,
      source: call.source,
      coin: t.coin,
      side: t.side,
      sizeUsd,
      qty: sizeUsd / mid,
      entry: mid,
      sl: t.sl,
      tp: t.tps[0],
      openedAt: now,
      status: 'open',
    }
    this.positions.push(pos)
    return { ok: true, position: pos }
  }

  pnl(pos, mid) {
    const dir = pos.side === 'long' ? 1 : -1
    const px = pos.status === 'open' ? mid : pos.exit
    if (!Number.isFinite(px)) return null
    const usd = pos.qty * (px - pos.entry) * dir
    const risk = pos.qty * Math.abs(pos.entry - pos.sl)
    return { usd: round2(usd), r: risk ? round2(usd / risk) : 0, price: px }
  }

  close(id, mid, reason = 'manual', now = Date.now()) {
    const pos = this.positions.find((p) => p.id === id && p.status === 'open')
    if (!pos) return { ok: false, reason: 'no such open position' }
    if (!Number.isFinite(mid)) return { ok: false, reason: `no price for ${pos.coin}` }
    pos.status = 'closed'
    pos.exit = mid
    pos.closedAt = now
    pos.closeReason = reason
    pos.pnlUsd = this.pnl(pos, mid).usd
    return { ok: true, position: pos }
  }

  /** Marks every open position; closes the ones whose stop or TP1 traded. */
  mark(mids, now = Date.now()) {
    const events = []
    for (const pos of this.open()) {
      const mid = mids[pos.coin]
      if (!Number.isFinite(mid)) continue
      const long = pos.side === 'long'
      if (long ? mid <= pos.sl : mid >= pos.sl) events.push(this.close(pos.id, pos.sl, 'stop', now).position)
      else if (long ? mid >= pos.tp : mid <= pos.tp) events.push(this.close(pos.id, pos.tp, 'tp1', now).position)
    }
    return events
  }
}
