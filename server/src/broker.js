// Where a tapped call goes.
//
// PaperBroker simulates the fill at the live price and watches the stop and
// TP1 itself: no keys, no account. DemoBroker sends real orders to a Binance
// demo account: a market entry, then the caller's stop and first target as
// closePosition orders held by Binance, so the exchange closes the trade even
// while this server is offline.

import { round2 } from './grade.js'

export const DEMO = 'binance-demo'

/** Decimal places of an exchange step such as "0.0010" (3) or "1" (0). */
function decimals(step) {
  const s = String(step)
  return s.includes('.') ? s.replace(/0+$/, '').split('.')[1].length : 0
}

/** `value` as an exact multiple of `step`, formatted the way Binance wants it. */
export function toStep(value, step, mode = 'round') {
  const n = value / Number(step)
  const k = mode === 'down' ? Math.floor(n + 1e-9) : mode === 'up' ? Math.ceil(n - 1e-9) : Math.round(n)
  return (k * Number(step)).toFixed(decimals(step))
}

/** Quantity for about `sizeUsd` of notional: down to the lot step, then up to the exchange minimums. */
export function sizeQty(sizeUsd, price, rule) {
  const step = Number(rule.step)
  let qty = Number(toStep(sizeUsd / price, rule.step, 'down'))
  if (qty < Math.max(rule.minQty, step)) qty = Math.max(rule.minQty, step)
  if (qty * price < rule.minNotional) qty = Number(toStep(rule.minNotional / price, rule.step, 'up'))
  return qty
}

export class PaperBroker {
  constructor(book) {
    this.book = book
    this.label = 'paper'
  }

  async init() {
    return { label: this.label }
  }

  preview(call, sizeUsd, mid) {
    return this.book.check(call, sizeUsd, mid)
  }

  async open(call, sizeUsd, mid, now) {
    return this.book.openFromCall(call, sizeUsd, mid, now)
  }

  async close(pos, mid, now) {
    return this.book.close(pos.id, mid, 'manual', now)
  }

  /** Closes paper positions whose stop or TP1 traded. */
  async sync(mids, now) {
    return this.book.mark(mids, now)
  }

  markOf(pos, mids) {
    return mids[pos.coin]
  }
}

export class DemoBroker {
  /**
   * @param {import('./paper.js').PaperBook} book  the ledger; demo positions are kept in it too
   * @param {ReturnType<import('./binance.js').createBinanceDemo>} client
   */
  constructor(book, client, { symbolOf = (coin) => `${coin}USDT`, log = () => {} } = {}) {
    this.book = book
    this.client = client
    this.symbolOf = symbolOf
    this.log = log
    this.label = 'demo'
    this.hedge = false
    this.rules = new Map()
    this.balance = null
  }

  async init() {
    await this.client.syncTime()
    this.rules = await this.client.rules()
    this.hedge = await this.client.hedgeMode()
    this.balance = await this.client.balance().catch(() => null)
    await this.reconcile()
    return { label: this.label, hedge: this.hedge, balance: this.balance, offsetMs: this.client.offset() }
  }

  /** Cancels our own stop and target orders left on symbols we no longer hold. */
  async reconcile() {
    const held = new Set(this.book.open().filter((p) => p.venue === DEMO).map((p) => p.symbol))
    const res = await this.client.openAlgoOrders().catch(() => [])
    const orders = Array.isArray(res) ? res : res?.orders ?? []
    for (const o of orders) {
      if (String(o.clientAlgoId ?? '').startsWith('ci') && !held.has(o.symbol)) await this.client.cancelAlgo(o.algoId).catch(() => {})
    }
  }

  rule(coin) {
    return this.rules.get(this.symbolOf(coin))
  }

  positionSide(side) {
    return this.hedge ? (side === 'long' ? 'LONG' : 'SHORT') : undefined
  }

  preview(call, sizeUsd, mid) {
    const c = this.book.check(call, sizeUsd, mid)
    if (!c.ok) return c
    const coin = call.ticket.coin
    const r = this.rule(coin)
    if (!r) return { ok: false, reason: `${coin} is not tradable on Binance demo` }
    const qty = sizeQty(sizeUsd, mid, r)
    const real = round2(qty * mid)
    if (real > this.book.maxSize) return { ok: false, reason: `Binance minimum on ${coin} is $${real}, above your $${this.book.maxSize} cap` }
    const p = c.preview
    return {
      ok: true,
      preview: {
        ...p,
        qty,
        sizeUsd: real,
        risk: round2(qty * Math.abs(mid - p.sl)),
        reward: round2(qty * Math.abs(p.tp - mid)),
        minNote: real > sizeUsd * 1.02 ? `raised to Binance's $${r.minNotional} minimum` : null,
      },
    }
  }

  async open(call, sizeUsd, mid, now) {
    const c = this.preview(call, sizeUsd, mid)
    if (!c.ok) return c
    const t = call.ticket
    const r = this.rule(t.coin)
    const symbol = this.symbolOf(t.coin)
    const long = t.side === 'long'
    const positionSide = this.positionSide(t.side)
    const tag = `ci${this.book.seq}x${now.toString(36)}`
    let fill
    try {
      fill = await this.client.marketOrder({ symbol, side: long ? 'BUY' : 'SELL', quantity: toStep(c.preview.qty, r.step, 'down'), positionSide, newClientOrderId: `${tag}e` })
    } catch (err) {
      return { ok: false, reason: `Binance refused the order: ${err.message}` }
    }
    const qty = Number(fill.executedQty)
    const entry = Number(fill.avgPrice)
    if (!(qty > 0 && entry > 0)) return { ok: false, reason: `entry order ${String(fill.status ?? 'not filled').toLowerCase()}` }
    const pos = {
      id: `P${this.book.seq++}`,
      callId: call.id,
      source: call.source,
      coin: t.coin,
      side: t.side,
      venue: DEMO,
      symbol,
      qty,
      sizeUsd: round2(qty * entry),
      entry,
      sl: t.sl,
      tp: t.tps[0],
      openedAt: now,
      status: 'open',
      orderId: fill.orderId,
    }
    this.book.positions.push(pos)

    const exit = { symbol, side: long ? 'SELL' : 'BUY', positionSide, closePosition: 'true', workingType: 'CONTRACT_PRICE' }
    try {
      pos.slAlgoId = (await this.client.algoOrder({ ...exit, type: 'STOP_MARKET', triggerPrice: toStep(t.sl, r.tick), clientAlgoId: `${tag}s` })).algoId
    } catch (err) {
      // Never leave a position without its stop. -2021: the stop already traded.
      const res = await this.flatten(pos, now, err.code === -2021 ? 'stop' : 'safety')
      return { ok: false, reason: `stop order refused (${err.message}), closed at market`, closed: res.ok ? res.position : null }
    }
    try {
      pos.tpAlgoId = (await this.client.algoOrder({ ...exit, type: 'TAKE_PROFIT_MARKET', triggerPrice: toStep(t.tps[0], r.tick), clientAlgoId: `${tag}t` })).algoId
    } catch (err) {
      if (err.code === -2021) {
        // TP1 traded between the tap and the order: take it.
        const res = await this.flatten(pos, now, 'tp1')
        return { ok: true, position: pos, closed: res.ok ? res.position : null }
      }
      pos.note = `no TP1 order (${err.message}), stop is set`
    }
    return { ok: true, position: pos }
  }

  async cancelLeftovers(pos) {
    for (const id of [pos.slAlgoId, pos.tpAlgoId]) if (id) await this.client.cancelAlgo(id).catch(() => {})
  }

  /** Market close of the whole position, then its stop and target are cancelled. */
  async flatten(pos, now, reason) {
    const long = pos.side === 'long'
    let order = null
    try {
      order = await this.client.marketOrder({
        symbol: pos.symbol,
        side: long ? 'SELL' : 'BUY',
        quantity: toStep(pos.qty, this.rule(pos.coin)?.step ?? '0.001', 'down'),
        ...(this.hedge ? { positionSide: this.positionSide(pos.side) } : { reduceOnly: 'true' }),
        newClientOrderId: `ci${pos.id}c${now.toString(36)}`,
      })
    } catch (err) {
      // -2022: nothing left to reduce, Binance already closed it.
      if (err.code !== -2022) return { ok: false, reason: `Binance refused the close: ${err.message}` }
    }
    await this.cancelLeftovers(pos)
    const exit = Number(order?.avgPrice) > 0 ? Number(order.avgPrice) : pos.mark ?? pos.entry
    return this.book.close(pos.id, exit, reason, now)
  }

  async close(pos, mid, now) {
    if (pos.venue !== DEMO) return this.book.close(pos.id, mid, 'manual', now)
    return this.flatten(pos, now, 'manual')
  }

  /**
   * Marks demo positions from Binance and books the ones Binance closed: by
   * the stop, by TP1, or by hand in the Binance app.
   */
  async sync(mids, now) {
    if (now - (this.balanceAt ?? 0) > 60_000) {
      this.balanceAt = now
      this.balance = await this.client.balance().catch(() => this.balance)
    }
    const closed = this.book.mark(mids, now) // paper positions opened before the key was set
    const open = this.book.open().filter((p) => p.venue === DEMO)
    if (!open.length) return closed
    let rows
    try {
      rows = await this.client.positions()
    } catch (err) {
      this.log(`positions failed: ${err.message}`)
      return closed
    }
    for (const p of open) {
      const side = this.hedge ? this.positionSide(p.side) : 'BOTH'
      const row = rows.find((r) => r.symbol === p.symbol && (r.positionSide ?? 'BOTH') === side)
      if (row && Math.abs(Number(row.positionAmt)) > 0) {
        p.mark = Number(row.markPrice)
        p.markAt = now
        p.flatSeen = 0
        continue
      }
      const [sl, tp] = await Promise.all([p.slAlgoId, p.tpAlgoId].map((id) => (id ? this.client.algoStatus(id).catch(() => null) : null)))
      const fired = (o) => Boolean(o?.actualOrderId) && Number(o.actualPrice) > 0
      let reason = fired(sl) ? 'stop' : fired(tp) ? 'tp1' : null
      if (!reason) {
        // Flat with neither order fired: closed in the Binance app. Look twice
        // first, so one lagging read can never cancel the stop of a live trade.
        p.flatSeen = (p.flatSeen ?? 0) + 1
        if (p.flatSeen < 2 || now - p.openedAt < 10_000) continue
        reason = 'binance'
      }
      const exit = reason === 'stop' ? Number(sl.actualPrice) : reason === 'tp1' ? Number(tp.actualPrice) : p.mark ?? mids[p.coin]
      await this.cancelLeftovers(p)
      const res = this.book.close(p.id, exit, reason, now)
      if (res.ok) closed.push(res.position)
    }
    return closed
  }

  markOf(pos, mids, now = Date.now()) {
    if (pos.venue === DEMO && Number.isFinite(pos.mark) && now - pos.markAt < 60_000) return pos.mark
    return mids[pos.coin]
  }
}
