import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Engine } from '../src/engine.js'
import { DemoBroker, toStep, sizeQty } from '../src/broker.js'
import { PaperBook } from '../src/paper.js'

const T0 = Date.UTC(2026, 10, 27, 9, 0)
const SOL_CALL = '🚀 LONG $SOL\nEntry 70.2 - 70.8\nSL 68.5\nTP 73 / 75.5'
const RULES = new Map([
  ['SOLUSDT', { tick: '0.0100', step: '0.01', minQty: 0.01, maxQty: 50000, minNotional: 5 }],
  ['BTCUSDT', { tick: '0.10', step: '0.0001', minQty: 0.0001, maxQty: 1000, minNotional: 50 }],
])
const binanceError = (msg, code) => Object.assign(new Error(`${msg} (${code})`), { code })

/** A Binance demo account in memory: market orders fill at `marks`, algo orders wait to be fired. */
function fakeDemo({ failSl = null, failTp = null } = {}) {
  const calls = []
  const algos = new Map()
  const held = new Map() // symbol -> signed position size
  const marks = { SOLUSDT: 70.52, BTCUSDT: 61000 }
  let seq = 100
  return {
    calls, algos, held, marks,
    syncTime: async () => 12_500,
    offset: () => 12_500,
    rules: async () => RULES,
    hedgeMode: async () => false,
    balance: async () => 5000,
    openAlgoOrders: async () => [...algos.values()].filter((a) => a.algoStatus === 'NEW'),
    async marketOrder(p) {
      calls.push(['order', p])
      const qty = Number(p.quantity)
      const had = held.get(p.symbol) ?? 0
      if (p.reduceOnly === 'true' && had === 0) throw binanceError('ReduceOnly Order is rejected.', -2022)
      held.set(p.symbol, Math.round((had + (p.side === 'BUY' ? qty : -qty)) * 1e8) / 1e8)
      return { orderId: ++seq, status: 'FILLED', executedQty: p.quantity, avgPrice: String(marks[p.symbol]) }
    },
    async algoOrder(p) {
      calls.push(['algo', p])
      if (p.type === 'STOP_MARKET' && failSl) throw failSl
      if (p.type === 'TAKE_PROFIT_MARKET' && failTp) throw failTp
      const a = { algoId: ++seq, ...p, algoStatus: 'NEW', actualOrderId: '', actualPrice: '0' }
      algos.set(a.algoId, a)
      return a
    },
    async cancelAlgo(id) {
      calls.push(['cancel', id])
      const a = algos.get(id)
      if (!a || a.algoStatus !== 'NEW') throw binanceError('Unknown order sent.', -2011)
      a.algoStatus = 'CANCELED'
      return a
    },
    algoStatus: async (id) => algos.get(id),
    async positions() {
      return [...held].map(([symbol, amt]) => ({ symbol, positionSide: 'BOTH', positionAmt: String(amt), markPrice: String(marks[symbol]), unRealizedProfit: '0' }))
    },
    /** Binance fires one of our algo orders: the position goes flat at `price`. */
    fire(type, price) {
      const a = [...algos.values()].find((x) => x.type === type && x.algoStatus === 'NEW')
      Object.assign(a, { algoStatus: 'FINISHED', actualOrderId: '999', actualPrice: String(price) })
      held.set(a.symbol, 0)
    },
  }
}

async function setup(demo = fakeDemo()) {
  const journal = []
  const clock = { t: T0 }
  const market = {
    universe: async () => new Set(['BTC', 'SOL']),
    symbolOf: (coin) => `${coin}USDT`,
    mids: async () => ({ SOL: 70.5, BTC: 61000 }),
    candles: async () => [],
  }
  const e = new Engine({ market, broker: (book) => new DemoBroker(book, demo), journal: async (t) => journal.push(t), now: () => clock.t })
  const info = await e.init()
  return { e, demo, journal, clock, info }
}

const flush = () => new Promise((r) => setImmediate(r))

test('quantities are exact multiples of the Binance step', () => {
  assert.equal(toStep(68.5, '0.0100'), '68.50')
  assert.equal(toStep(0.0000881234, '0.0000001'), '0.0000881')
  assert.equal(toStep(0.709, '0.01', 'down'), '0.70')
  assert.equal(toStep(0.000813, '0.0001', 'up'), '0.0009')
  assert.equal(toStep(1234.6, '1', 'down'), '1234')
})

test('a $50 BTC order is raised to Binance\'s $50 minimum and the card says so', () => {
  assert.equal(sizeQty(50, 61000, RULES.get('BTCUSDT')), 0.0009)
  const book = new PaperBook()
  const b = new DemoBroker(book, fakeDemo())
  b.rules = RULES
  const call = { id: 'C1', source: 'Desk', ticket: { side: 'long', coin: 'BTC', entry: null, sl: 59000, tps: [65000] } }
  const c = b.preview(call, 50, 61000)
  assert.equal(c.ok, true)
  assert.equal(c.preview.sizeUsd, 54.9)
  assert.match(c.preview.minNote, /Binance's \$50 minimum/)
})

test('tap, tap: a market order on Binance demo, then the stop and TP1 as orders Binance holds', async () => {
  const { e, demo, journal, info } = await setup()
  assert.equal(info.label, 'demo')
  await e.ingest({ text: SOL_CALL, source: 'Alpha Desk', postedAt: T0 })
  let v = e.view()
  assert.match(v.footer, /tap {2}demo \$50/)
  v = await e.input('tap')
  assert.equal(v.header, 'CONFIRM BINANCE DEMO ORDER')
  assert.match(v.body, /\$49\.35 at 70\.50/)
  v = await e.input('tap')
  const [entry, sl, tp] = demo.calls
  assert.deepEqual([entry[0], entry[1].symbol, entry[1].side, entry[1].quantity], ['order', 'SOLUSDT', 'BUY', '0.70'])
  assert.deepEqual([sl[1].type, sl[1].side, sl[1].triggerPrice, sl[1].closePosition], ['STOP_MARKET', 'SELL', '68.50', 'true'])
  assert.deepEqual([tp[1].type, tp[1].triggerPrice], ['TAKE_PROFIT_MARKET', '73.00'])
  assert.equal(v.kind, 'position')
  assert.match(v.header, /^BINANCE DEMO · Alpha Desk/)
  assert.match(v.footer, /Demo long SOL filled at 70\.52/)
  await flush()
  assert.match(journal[0], /Binance demo LONG SOL \$49\.36 @ 70\.52/)
})

test('Binance closes it at TP1: booked at Binance\'s fill price, and the stop order is cancelled', async () => {
  const { e, demo, journal } = await setup()
  await e.ingest({ text: SOL_CALL, source: 'Alpha Desk', postedAt: T0 })
  await e.input('tap')
  await e.input('tap')
  const slId = demo.calls[1][1] && [...demo.algos.values()].find((a) => a.type === 'STOP_MARKET').algoId
  demo.fire('TAKE_PROFIT_MARKET', 73.01)
  await e.tick()
  await flush()
  assert.equal(e.book.open().length, 0)
  const p = e.book.positions[0]
  assert.equal(p.closeReason, 'tp1')
  assert.equal(p.exit, 73.01)
  assert.ok(demo.calls.some(([k, id]) => k === 'cancel' && id === slId), 'the leftover stop is cancelled')
  assert.match(journal.at(-1), /✅ SOL long TP1 hit @ 73\.01 {2}\+\$1\.74 \(\+1\.23R\) \(Binance demo\)/)
})

test('a refused stop order means the position is closed at once', async () => {
  const { e, demo } = await setup(fakeDemo({ failSl: binanceError('Precision is over the maximum defined for this asset.', -1111) }))
  await e.ingest({ text: SOL_CALL, source: 'Alpha Desk', postedAt: T0 })
  await e.input('tap')
  const v = await e.input('tap')
  assert.match(v.footer, /Can't demo this: stop order refused/)
  const close = demo.calls.find(([k, p]) => k === 'order' && p.reduceOnly === 'true')
  assert.ok(close, 'a reduce-only market order closed it')
  assert.equal(demo.held.get('SOLUSDT'), 0)
  assert.equal(e.book.open().length, 0)
  assert.equal(e.book.positions[0].closeReason, 'safety')
})

test('closed by hand in the Binance app: booked only after a second look, then both orders are cancelled', async () => {
  const { e, demo, clock } = await setup()
  await e.ingest({ text: SOL_CALL, source: 'Alpha Desk', postedAt: T0 })
  await e.input('tap')
  await e.input('tap')
  demo.held.set('SOLUSDT', 0)
  clock.t += 20_000
  await e.tick()
  assert.equal(e.book.open().length, 1, 'one flat read is not enough')
  clock.t += 3_000
  await e.tick()
  assert.equal(e.book.open().length, 0)
  assert.equal(e.book.positions[0].closeReason, 'binance')
  assert.equal(demo.calls.filter(([k]) => k === 'cancel').length, 2)
})

test('tap close on the glasses: market close on Binance, then its orders are cancelled', async () => {
  const { e, demo } = await setup()
  await e.ingest({ text: SOL_CALL, source: 'Alpha Desk', postedAt: T0 })
  await e.input('tap')
  await e.input('tap')
  demo.marks.SOLUSDT = 71
  let v = await e.input('tap')
  assert.equal(v.header, 'CLOSE AT MARKET ON BINANCE DEMO?')
  v = await e.input('tap')
  assert.match(v.footer, /Closed SOL \+\$0\.34/)
  const order = demo.calls.filter(([k]) => k === 'order').at(-1)[1]
  assert.deepEqual([order.side, order.quantity, order.reduceOnly], ['SELL', '0.70', 'true'])
  assert.equal(demo.calls.filter(([k]) => k === 'cancel').length, 2)
})

test('a demo key Binance refuses falls back to paper trades', async () => {
  const demo = fakeDemo()
  demo.hedgeMode = async () => { throw binanceError('Invalid API-key, IP, or permissions for action.', -2015) }
  const { e, info } = await setup(demo)
  assert.equal(info.label, 'paper')
  assert.match(e.venueLine(), /Binance demo key refused/)
})

test('the daily loss cap stops new trades', async () => {
  const { e } = await setup()
  e.settings.dailyLossCap = 1
  e.book.positions.push({ id: 'P9', status: 'closed', closedAt: T0 - 3_600_000, pnlUsd: -1.42 })
  await e.ingest({ text: SOL_CALL, source: 'Alpha Desk', postedAt: T0 })
  const v = await e.input('tap')
  assert.equal(v.mode, 'browse')
  assert.match(v.footer, /\$1 daily loss cap reached/)
})
