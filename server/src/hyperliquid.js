// Read-only Hyperliquid client: market list, mid prices, candles.
// No keys, no orders: CalledIt only ever reads the exchange.

const URLS = {
  mainnet: 'https://api.hyperliquid.xyz/info',
  testnet: 'https://api.hyperliquid-testnet.xyz/info',
}

const IV_MS = { '1m': 60_000, '15m': 900_000, '1h': 3_600_000 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Hyperliquid limits info requests by weight per IP (1200 a minute; a candle
 * snapshot costs 20 plus 1 per 60 candles). Grading a batch of forwarded calls
 * would blow through that, so candle requests share a weight budget, candles
 * are cached per coin and interval (later calls only fetch the new tail), and
 * a 429 is retried with backoff instead of failing the grade.
 */
export function createHyperliquid({ network = 'mainnet', fetchImpl = globalThis.fetch, weightPerMinute = 800, wait = sleep } = {}) {
  const url = URLS[network]
  if (!url) throw new Error(`unknown Hyperliquid network: ${network}`)

  async function info(body, tries = 5) {
    for (let i = 0; ; i++) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status === 429 && i < tries - 1) { await wait(1500 * 2 ** i); continue }
      if (!res.ok) throw new Error(`hyperliquid ${body.type}: HTTP ${res.status}`)
      return res.json()
    }
  }

  // Token bucket for candle requests, serialised so bursts queue instead of failing.
  let tokens = weightPerMinute
  let refilled = Date.now()
  let queue = Promise.resolve()
  function take(cost) {
    const turn = queue.then(async () => {
      for (;;) {
        const now = Date.now()
        tokens = Math.min(weightPerMinute, tokens + ((now - refilled) * weightPerMinute) / 60_000)
        refilled = now
        if (tokens >= cost) { tokens -= cost; return }
        await wait(Math.ceil(((cost - tokens) * 60_000) / weightPerMinute))
      }
    })
    queue = turn.catch(() => {})
    return turn
  }

  async function fetchCandles(coin, interval, startTime, endTime) {
    await take(20)
    const rows = await info({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } })
    tokens -= Math.ceil(rows.length / 60)
    return rows.map((c) => ({ t: c.t, T: c.T, o: +c.o, h: +c.h, l: +c.l, c: +c.c }))
  }

  const cache = new Map() // "coin|interval" -> { start, rows, fetchedTo }

  return {
    network,
    /** Perp names that are listed and not delisted, e.g. "BTC", "kPEPE". */
    async universe() {
      const meta = await info({ type: 'meta' })
      return new Set(meta.universe.filter((u) => !u.isDelisted).map((u) => u.name))
    },
    /** Mid price per perp. Spot pairs ("@107") are dropped. */
    async mids() {
      const raw = await info({ type: 'allMids' }, 1)
      const out = {}
      for (const [k, v] of Object.entries(raw)) if (!k.startsWith('@') && !k.includes(':')) out[k] = Number(v)
      return out
    },
    async candles(coin, interval, startTime, endTime) {
      const key = `${coin}|${interval}`
      let c = cache.get(key)
      if (!c || c.start > startTime) {
        const rows = await fetchCandles(coin, interval, startTime, endTime)
        c = { start: startTime, rows, fetchedTo: endTime }
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

/** Finest candle interval whose 5,000-candle window still reaches back to `since`. */
export function intervalFor(since, now = Date.now()) {
  const age = now - since
  const day = 86_400_000
  if (age <= 3.3 * day) return { interval: '1m', ms: 60_000 }
  if (age <= 50 * day) return { interval: '15m', ms: 900_000 }
  if (age <= 200 * day) return { interval: '1h', ms: 3_600_000 }
  return null
}

/**
 * Candles from the moment a call was posted until now. With 1m candles the
 * minute of the post is kept; coarser candles that began before the post are
 * dropped so nothing that happened before the call can grade it.
 */
export async function candlesSince(hl, coin, postedAt, now = Date.now()) {
  const iv = intervalFor(postedAt, now)
  if (!iv) return null
  const start = Math.floor(postedAt / iv.ms) * iv.ms
  const rows = await hl.candles(coin, iv.interval, start, now)
  return rows.filter((k) => (iv.ms === 60_000 ? k.t >= start : k.t >= postedAt))
}
