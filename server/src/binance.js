// Binance USD-M Futures.
//
// Prices, candles and the market list are public and come from the main
// futures API: a call is about the real market, so it is graded there.
// Orders go only to Binance's demo trading host with a demo API key, so a
// tapped call becomes a real order on a demo account with no real funds.

import { createHmac } from 'node:crypto'

export const MARKET_URL = 'https://fapi.binance.com'
export const DEMO_URL = 'https://demo-fapi.binance.com'

const IV_MS = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 }
const PAGE = 1000 // klines per request; weight 5 (a 1500 page costs 10)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Token bucket shared by one client's requests, serialised so bursts queue instead of failing. */
function weightBudget(perMinute, wait) {
  let tokens = perMinute
  let refilled = Date.now()
  let queue = Promise.resolve()
  return function take(cost) {
    const turn = queue.then(async () => {
      for (;;) {
        const now = Date.now()
        tokens = Math.min(perMinute, tokens + ((now - refilled) * perMinute) / 60_000)
        refilled = now
        if (tokens >= cost) { tokens -= cost; return }
        await wait(Math.ceil(((cost - tokens) * 60_000) / perMinute))
      }
    })
    queue = turn.catch(() => {})
    return turn
  }
}

/**
 * Public market data. Binance weighs requests per IP (2,400 a minute on the
 * main API). Requests share a budget of half that, candles are cached per
 * coin and interval (later calls fetch only the new tail), and 429, 418 and
 * 5xx answers are retried with backoff instead of failing a grade.
 */
export function createBinance({ fetchImpl = globalThis.fetch, baseUrl = MARKET_URL, weightPerMinute = 1200, wait = sleep } = {}) {
  const take = weightBudget(weightPerMinute, wait)

  async function get(path, params, weight, tries = 5) {
    await take(weight)
    const url = baseUrl + path + (params ? '?' + new URLSearchParams(params) : '')
    for (let i = 0; ; i++) {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) })
      if ((res.status === 429 || res.status === 418 || res.status >= 500) && i < tries - 1) {
        await wait(1500 * 2 ** i)
        continue
      }
      if (!res.ok) throw new Error(`binance ${path}: HTTP ${res.status}`)
      return res.json()
    }
  }

  const symbols = new Map() // coin -> symbol: "SOL" -> "SOLUSDT", "1000PEPE" -> "1000PEPEUSDT"
  const cache = new Map() // "coin|interval" -> { start, rows, fetchedTo }
  const symbolOf = (coin) => symbols.get(coin) ?? `${coin}USDT`

  async function fetchCandles(coin, interval, startTime, endTime) {
    const out = []
    for (let from = startTime; from <= endTime; ) {
      const rows = await get('/fapi/v1/klines', { symbol: symbolOf(coin), interval, startTime: from, endTime, limit: PAGE }, 5)
      for (const k of rows) out.push({ t: k[0], T: k[6], o: +k[1], h: +k[2], l: +k[3], c: +k[4] })
      if (rows.length < PAGE) break
      from = rows.at(-1)[0] + IV_MS[interval]
    }
    return out
  }

  return {
    name: 'Binance USD-M',
    symbolOf,
    /** Coins with a trading USDT perpetual, e.g. "BTC", "1000PEPE". */
    async universe() {
      const info = await get('/fapi/v1/exchangeInfo', null, 1)
      symbols.clear()
      for (const s of info.symbols) {
        if (s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING') symbols.set(s.baseAsset, s.symbol)
      }
      return new Set(symbols.keys())
    },
    /** Last trade price per coin (one request for all symbols, weight 2). */
    async mids() {
      const rows = await get('/fapi/v2/ticker/price', null, 2, 1)
      const coinOf = new Map([...symbols].map(([coin, sym]) => [sym, coin]))
      const out = {}
      for (const r of rows) {
        const coin = coinOf.get(r.symbol)
        if (coin) out[coin] = Number(r.price)
      }
      return out
    },
    async candles(coin, interval, startTime, endTime) {
      if (!IV_MS[interval]) throw new Error(`unsupported interval ${interval}`)
      const key = `${coin}|${interval}`
      let c = cache.get(key)
      if (!c || c.start > startTime) {
        c = { start: startTime, rows: await fetchCandles(coin, interval, startTime, endTime), fetchedTo: endTime }
        cache.set(key, c)
      } else if (endTime - c.fetchedTo > 30_000) {
        // Only the tail is new: refetch from the last (possibly unfinished) candle.
        const from = c.rows.length ? c.rows.at(-1).t : c.start
        const tail = await fetchCandles(coin, interval, from, endTime)
        c.rows = c.rows.filter((k) => k.t < from).concat(tail)
        c.fetchedTo = endTime
      }
      return c.rows.filter((k) => k.t >= startTime && k.t <= endTime)
    },
  }
}

/**
 * Candle interval for grading a call posted at `since`. Binance keeps the full
 * history, so the limit is request count: each choice stays near 5 to 10 pages.
 */
export function intervalFor(since, now = Date.now()) {
  const age = now - since
  const day = 86_400_000
  if (age <= 3 * day) return { interval: '1m', ms: 60_000 }
  if (age <= 15 * day) return { interval: '5m', ms: 300_000 }
  if (age <= 45 * day) return { interval: '15m', ms: 900_000 }
  if (age <= 400 * day) return { interval: '1h', ms: 3_600_000 }
  return null
}

/**
 * Candles from the moment a call was posted until now. With 1m candles the
 * minute of the post is kept; coarser candles that began before the post are
 * dropped so nothing that happened before the call can grade it.
 */
export async function candlesSince(market, coin, postedAt, now = Date.now()) {
  const iv = intervalFor(postedAt, now)
  if (!iv) return null
  const start = Math.floor(postedAt / iv.ms) * iv.ms
  const rows = await market.candles(coin, iv.interval, start, now)
  return rows.filter((k) => (iv.ms === 60_000 ? k.t >= start : k.t >= postedAt))
}

// ---- demo trading ------------------------------------------------------------

export class BinanceError extends Error {
  constructor(path, status, body) {
    super(`${body?.msg ?? `HTTP ${status}`}${typeof body?.code === 'number' ? ` (${body.code})` : ''}`)
    this.path = path
    this.status = status
    this.code = typeof body?.code === 'number' ? body.code : null
  }
}

/** HMAC SHA256 of the exact query string, hex, as Binance expects it. */
export function signQuery(query, secret) {
  return createHmac('sha256', secret).update(query).digest('hex')
}

const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null))

/** Exchange rules per symbol from exchangeInfo: price tick, market lot step, minimums. */
export function parseRules(info) {
  const rules = new Map()
  for (const s of info.symbols) {
    if (s.contractType !== 'PERPETUAL' || s.status !== 'TRADING') continue
    const f = Object.fromEntries(s.filters.map((x) => [x.filterType, x]))
    const lot = f.MARKET_LOT_SIZE ?? f.LOT_SIZE
    if (!f.PRICE_FILTER || !lot) continue
    rules.set(s.symbol, {
      tick: f.PRICE_FILTER.tickSize,
      step: lot.stepSize,
      minQty: Number(lot.minQty),
      maxQty: Number(lot.maxQty),
      minNotional: Number(f.MIN_NOTIONAL?.notional ?? 0),
    })
  }
  return rules
}

/**
 * Signed REST on Binance's demo trading host. The host is fixed on purpose:
 * this client has no way to reach a real-money account.
 */
export function createBinanceDemo({ apiKey, apiSecret, fetchImpl = globalThis.fetch, now = Date.now, recvWindow = 5000 }) {
  const baseUrl = DEMO_URL
  let offset = 0
  let syncedAt = 0

  /** Binance rejects a timestamp outside recvWindow; this laptop ran 12.5 s behind. */
  async function syncTime() {
    const t0 = now()
    const res = await fetchImpl(`${baseUrl}/fapi/v1/time`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new BinanceError('/fapi/v1/time', res.status, null)
    const { serverTime } = await res.json()
    const t1 = now()
    offset = serverTime - Math.round((t0 + t1) / 2)
    syncedAt = t1
    return offset
  }

  async function signed(method, path, params = {}, retry = true) {
    if (!syncedAt || now() - syncedAt > 15 * 60_000) await syncTime()
    const query = new URLSearchParams({ ...defined(params), recvWindow: String(recvWindow), timestamp: String(now() + offset) }).toString()
    const res = await fetchImpl(`${baseUrl}${path}?${query}&signature=${signQuery(query, apiSecret)}`, {
      method,
      headers: { 'X-MBX-APIKEY': apiKey },
      signal: AbortSignal.timeout(15_000),
    })
    const body = await res.json().catch(() => null)
    if (body?.code === -1021 && retry) {
      await syncTime()
      return signed(method, path, params, false)
    }
    if (!res.ok || (typeof body?.code === 'number' && body.code < 0)) throw new BinanceError(path, res.status, body)
    return body
  }

  return {
    host: baseUrl,
    syncTime,
    offset: () => offset,
    async rules() {
      const res = await fetchImpl(`${baseUrl}/fapi/v1/exchangeInfo`, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new BinanceError('/fapi/v1/exchangeInfo', res.status, null)
      return parseRules(await res.json())
    },
    async hedgeMode() {
      return (await signed('GET', '/fapi/v1/positionSide/dual')).dualSidePosition === true
    },
    /** Available USDT on the demo account. */
    async balance() {
      const rows = await signed('GET', '/fapi/v2/balance')
      const usdt = rows.find((r) => r.asset === 'USDT')
      return usdt ? Number(usdt.availableBalance) : null
    },
    positions: () => signed('GET', '/fapi/v3/positionRisk'),
    marketOrder: (p) => signed('POST', '/fapi/v1/order', { type: 'MARKET', newOrderRespType: 'RESULT', ...p }),
    /** Conditional orders (STOP_MARKET, TAKE_PROFIT_MARKET) live on the algo service since 2025-12-09. */
    algoOrder: (p) => signed('POST', '/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', ...p }),
    cancelAlgo: (algoId) => signed('DELETE', '/fapi/v1/algoOrder', { algoId }),
    algoStatus: (algoId) => signed('GET', '/fapi/v1/algoOrder', { algoId }),
    openAlgoOrders: () => signed('GET', '/fapi/v1/openAlgoOrders'),
  }
}
