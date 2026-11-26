// Read-only Hyperliquid client: market list, mid prices, candles.
// No keys, no orders: CalledIt only ever reads the exchange.

const URLS = {
  mainnet: 'https://api.hyperliquid.xyz/info',
  testnet: 'https://api.hyperliquid-testnet.xyz/info',
}

export function createHyperliquid({ network = 'mainnet', fetchImpl = globalThis.fetch } = {}) {
  const url = URLS[network]
  if (!url) throw new Error(`unknown Hyperliquid network: ${network}`)

  async function info(body) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`hyperliquid ${body.type}: HTTP ${res.status}`)
    return res.json()
  }

  return {
    network,
    /** Perp names that are listed and not delisted, e.g. "BTC", "kPEPE". */
    async universe() {
      const meta = await info({ type: 'meta' })
      return new Set(meta.universe.filter((u) => !u.isDelisted).map((u) => u.name))
    },
    /** Mid price per perp. Spot pairs ("@107") are dropped. */
    async mids() {
      const raw = await info({ type: 'allMids' })
      const out = {}
      for (const [k, v] of Object.entries(raw)) if (!k.startsWith('@') && !k.includes(':')) out[k] = Number(v)
      return out
    },
    async candles(coin, interval, startTime, endTime) {
      const rows = await info({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } })
      return rows.map((c) => ({ t: c.t, T: c.T, o: +c.o, h: +c.h, l: +c.l, c: +c.c }))
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
