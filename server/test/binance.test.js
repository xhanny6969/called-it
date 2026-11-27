import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBinance, createBinanceDemo, signQuery, intervalFor, candlesSince, parseRules } from '../src/binance.js'

const MIN = 60_000
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

test('signature matches the example in the Binance docs', () => {
  const secret = '2b5eb11e18796d12d88f13dc27dbbd02c2cc51ff7059765ed9821957d82bb4d9'
  const query = 'symbol=BTCUSDT&side=BUY&type=LIMIT&quantity=1&price=9000&timeInForce=GTC&recvWindow=5000&timestamp=1591702613943'
  assert.equal(signQuery(query, secret), '3c661234138461fcc7a7d8746c6558c9842d4e10870d2ecbedf7777cad694af9')
})

const INFO = {
  symbols: [
    { symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.0100' }, { filterType: 'LOT_SIZE', stepSize: '0.01', minQty: '0.01', maxQty: '1000000' }, { filterType: 'MARKET_LOT_SIZE', stepSize: '0.01', minQty: '0.01', maxQty: '50000' }, { filterType: 'MIN_NOTIONAL', notional: '5' }] },
    { symbol: '1000PEPEUSDT', baseAsset: '1000PEPE', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.0000001' }, { filterType: 'MARKET_LOT_SIZE', stepSize: '1', minQty: '1', maxQty: '1e9' }, { filterType: 'MIN_NOTIONAL', notional: '5' }] },
    { symbol: 'BTCUSDT_261225', baseAsset: 'BTC', quoteAsset: 'USDT', contractType: 'CURRENT_QUARTER', status: 'TRADING', filters: [] },
    { symbol: 'ETHUSDC', baseAsset: 'ETH', quoteAsset: 'USDC', contractType: 'PERPETUAL', status: 'TRADING', filters: [] },
    { symbol: 'OLDUSDT', baseAsset: 'OLD', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'SETTLING', filters: [] },
  ],
}

test('the market list keeps trading USDT perpetuals only, and prices map back to coins', async () => {
  const fetchImpl = async (url) => (url.includes('exchangeInfo') ? json(INFO) : json([{ symbol: 'SOLUSDT', price: '70.51' }, { symbol: '1000PEPEUSDT', price: '0.0089' }, { symbol: 'ETHUSDC', price: '1700' }]))
  const b = createBinance({ fetchImpl, wait: async () => {} })
  assert.deepEqual([...(await b.universe())].sort(), ['1000PEPE', 'SOL'])
  assert.deepEqual(await b.mids(), { SOL: 70.51, '1000PEPE': 0.0089 })
  assert.equal(b.symbolOf('1000PEPE'), '1000PEPEUSDT')
})

function klineFetch() {
  const calls = []
  const fn = async (url) => {
    const q = new URL(url).searchParams
    calls.push(Object.fromEntries(q))
    const start = Number(q.get('startTime'))
    const end = Number(q.get('endTime'))
    const limit = Number(q.get('limit'))
    const rows = []
    for (let t = Math.ceil(start / MIN) * MIN; t <= end && rows.length < limit; t += MIN) rows.push([t, '1', '2', '0.5', '1.5', '10', t + MIN - 1])
    return json(rows)
  }
  return { fn, calls }
}

test('candles page through Binance 1000 at a time and are cached per coin', async () => {
  const f = klineFetch()
  const b = createBinance({ fetchImpl: f.fn, wait: async () => {} })
  const rows = await b.candles('SOL', '1m', 0, 1500 * MIN)
  assert.equal(rows.length, 1501)
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[0].limit, '1000')
  assert.equal(Number(f.calls[1].startTime), 1000 * MIN, 'second page starts one candle after the first page')
  assert.deepEqual(rows[0], { t: 0, T: MIN - 1, o: 1, h: 2, l: 0.5, c: 1.5 })
  await b.candles('SOL', '1m', 100 * MIN, 1500 * MIN)
  assert.equal(f.calls.length, 2, 'same window: served from the cache')
  await b.candles('SOL', '1m', 0, 1600 * MIN)
  assert.equal(f.calls.length, 3)
  assert.equal(Number(f.calls[2].startTime), 1500 * MIN, 'only the tail is fetched')
})

test('a 429 is retried with backoff instead of failing the grade', async () => {
  let failures = 2
  const waits = []
  const fetchImpl = async () => (failures-- > 0 ? json({}, 429) : json([]))
  const b = createBinance({ fetchImpl, wait: async (ms) => { waits.push(ms) } })
  assert.deepEqual(await b.candles('SOL', '1m', 0, MIN), [])
  assert.deepEqual(waits, [1500, 3000])
})

test('older calls are graded on coarser candles, and never on candles from before the post', async () => {
  const now = Date.UTC(2026, 10, 27)
  assert.equal(intervalFor(now - 2 * 86_400_000, now).interval, '1m')
  assert.equal(intervalFor(now - 10 * 86_400_000, now).interval, '5m')
  assert.equal(intervalFor(now - 30 * 86_400_000, now).interval, '15m')
  assert.equal(intervalFor(now - 180 * 86_400_000, now).interval, '1h')
  assert.equal(intervalFor(now - 500 * 86_400_000, now), null)
  const posted = now - 10 * 86_400_000 + 2 * MIN // inside a 5m candle
  const market = { candles: async (_c, _iv, start) => [{ t: start }, { t: start + 5 * MIN }] }
  const rows = await candlesSince(market, 'SOL', posted, now)
  assert.equal(rows.length, 1, 'the 5m candle that began before the post is dropped')
})

test('exchange rules come from the lot and price filters', () => {
  const r = parseRules(INFO)
  assert.deepEqual(r.get('SOLUSDT'), { tick: '0.0100', step: '0.01', minQty: 0.01, maxQty: 50000, minNotional: 5 })
  assert.equal(r.get('1000PEPEUSDT').step, '1')
  assert.equal(r.has('OLDUSDT'), false)
})

// ---- signed demo client ------------------------------------------------------

function demoFetch({ skew = 12_500, failFirst = null } = {}) {
  const calls = []
  let pending = failFirst
  const fn = async (url, init = {}) => {
    const u = new URL(url)
    if (u.pathname === '/fapi/v1/time') return json({ serverTime: 1_000_000 + skew })
    calls.push({ url: u, init })
    if (pending) { const p = pending; pending = null; return json(p, 400) }
    return json({ dualSidePosition: false })
  }
  return { fn, calls }
}

test('signed calls go to the demo host with the server clock offset and a valid signature', async () => {
  const f = demoFetch()
  const d = createBinanceDemo({ apiKey: 'k'.repeat(64), apiSecret: 's'.repeat(64), fetchImpl: f.fn, now: () => 1_000_000 })
  assert.equal(await d.hedgeMode(), false)
  const { url, init } = f.calls[0]
  assert.equal(url.origin, 'https://demo-fapi.binance.com')
  assert.equal(init.headers['X-MBX-APIKEY'], 'k'.repeat(64))
  assert.equal(url.searchParams.get('timestamp'), String(1_000_000 + 12_500), 'local clock is 12.5 s behind: the offset is added')
  const query = url.search.slice(1).replace(/&signature=.*$/, '')
  assert.equal(url.searchParams.get('signature'), signQuery(query, 's'.repeat(64)))
})

test('a -1021 timestamp error resyncs the clock and retries once', async () => {
  const f = demoFetch({ failFirst: { code: -1021, msg: 'Timestamp for this request is outside of the recvWindow.' } })
  const d = createBinanceDemo({ apiKey: 'k'.repeat(64), apiSecret: 's'.repeat(64), fetchImpl: f.fn, now: () => 1_000_000 })
  assert.equal(await d.hedgeMode(), false)
  assert.equal(f.calls.length, 2)
})

test('Binance errors keep their code', async () => {
  const fetchImpl = async (url) => (url.includes('/time') ? json({ serverTime: 1 }) : json({ code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }, 401))
  const d = createBinanceDemo({ apiKey: 'k'.repeat(64), apiSecret: 's'.repeat(64), fetchImpl, now: () => 1 })
  await assert.rejects(d.balance(), (err) => err.code === -2015 && /Invalid API-key/.test(err.message))
})
