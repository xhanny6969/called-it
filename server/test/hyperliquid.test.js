import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHyperliquid } from '../src/hyperliquid.js'

const H = 3_600_000
function fakeFetch({ fail429 = 0 } = {}) {
  const calls = []
  let failures = fail429
  const fn = async (_url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    if (failures > 0) { failures--; return { ok: false, status: 429, json: async () => ({}) } }
    const { startTime, endTime } = body.req
    const rows = []
    for (let t = Math.ceil(startTime / H) * H; t <= endTime; t += H) rows.push({ t, T: t + H - 1, o: '1', h: '2', l: '0.5', c: '1.5' })
    return { ok: true, status: 200, json: async () => rows }
  }
  return { fn, calls }
}

test('candles are cached per coin: a second call only fetches the new tail', async () => {
  const f = fakeFetch()
  const hl = createHyperliquid({ fetchImpl: f.fn, wait: async () => {} })
  const a = await hl.candles('SOL', '1h', 0, 100 * H)
  assert.equal(a.length, 101)
  const b = await hl.candles('SOL', '1h', 50 * H, 100 * H)
  assert.equal(b.length, 51)
  assert.equal(f.calls.length, 1, 'same window: served from cache')
  const c = await hl.candles('SOL', '1h', 10 * H, 120 * H)
  assert.equal(c.length, 111)
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].req.startTime, 100 * H, 'tail starts at the last cached candle')
  await hl.candles('ETH', '1h', 0, 10 * H)
  assert.equal(f.calls.length, 3, 'other coins are fetched separately')
})

test('a 429 is retried with backoff instead of failing the grade', async () => {
  const f = fakeFetch({ fail429: 2 })
  const waits = []
  const hl = createHyperliquid({ fetchImpl: f.fn, wait: async (ms) => { waits.push(ms) } })
  const rows = await hl.candles('BTC', '1h', 0, 5 * H)
  assert.equal(rows.length, 6)
  assert.deepEqual(waits, [1500, 3000])
})

test('candle requests wait for the weight budget instead of bursting', async () => {
  const f = fakeFetch()
  const waits = []
  const hl = createHyperliquid({ fetchImpl: f.fn, weightPerMinute: 40, wait: async (ms) => { waits.push(ms) } })
  await hl.candles('A', '1h', 0, H)
  await hl.candles('B', '1h', 0, H)
  await hl.candles('C', '1h', 0, H)
  assert.ok(waits.length >= 1, 'the third request had to wait for tokens')
})
