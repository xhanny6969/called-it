import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Engine } from '../src/engine.js'

const MIN = 60_000
const T0 = Date.UTC(2026, 10, 26, 9, 0)

function fakeMarket({ mids, candles = {} }) {
  return {
    universe: async () => new Set(['BTC', 'ETH', 'SOL', 'HYPE', '1000PEPE']),
    symbolOf: (coin) => `${coin}USDT`,
    mids: async () => ({ ...mids }),
    candles: async (coin, interval, start) => (candles[coin] ?? []).filter((k) => k.t >= start),
  }
}

async function setup({ mids = { SOL: 70.5, BTC: 61000 }, candles, now = T0, broker } = {}) {
  const journal = []
  const clock = { t: now }
  const market = fakeMarket({ mids, candles })
  const e = new Engine({ market, broker, journal: async (text) => journal.push(text), now: () => clock.t })
  await e.init()
  return { e, journal, clock, market, mids }
}

const SOL_CALL = '🚀 LONG $SOL\nEntry 70.2 - 70.8\nSL 68.5\nTP 73 / 75.5'

test('a live call becomes the card on the glasses', async () => {
  const { e } = await setup()
  const { reply } = await e.ingest({ text: SOL_CALL, source: 'Alpha Desk', chatId: -100, postedAt: T0 })
  assert.match(reply, /On your glasses: LONG SOL/)
  const v = e.view()
  assert.equal(v.kind, 'call')
  assert.match(v.header, /NEW CALL · Alpha Desk · just now/)
  assert.match(v.body, /▲ LONG SOL/)
  assert.match(v.body, /in the entry zone/)
  assert.match(v.footer, /tap {2}paper \$50/)
})

test('tap, tap: a paper position opens and the journal gets it', async () => {
  const { e, journal } = await setup()
  await e.ingest({ text: SOL_CALL, source: 'Alpha Desk', postedAt: T0 })
  let v = await e.input('tap')
  assert.equal(v.mode, 'confirm')
  assert.match(v.body, /\$50 at 70\.50/)
  assert.match(v.body, /Stop 68\.50 +if hit {2}−\$1\.42/)
  v = await e.input('tap')
  assert.equal(v.kind, 'position')
  assert.match(v.footer, /opened · logged to Telegram/)
  await new Promise((r) => setImmediate(r))
  assert.match(journal[0], /Paper LONG SOL \$50 @ 70\.50/)
})

test('swipe on the confirm card cancels instead of moving', async () => {
  const { e } = await setup()
  await e.ingest({ text: SOL_CALL, source: 'Alpha Desk', postedAt: T0 })
  await e.input('tap')
  const v = await e.input('next')
  assert.equal(v.mode, 'browse')
  assert.equal(v.kind, 'call')
  assert.equal(e.book.open().length, 0)
})

test('voice: "Paper 100." sets the size and asks for a tap', async () => {
  const { e } = await setup()
  await e.ingest({ text: SOL_CALL, source: 'Alpha Desk', postedAt: T0 })
  const v = await e.voice('Make it 100.')
  assert.equal(v.mode, 'confirm')
  assert.match(v.body, /\$100 at/)
  assert.match(v.footer, /heard "Make it 100\." → \$100/)
})

test('voice: "Skip this one." drops the call from the deck', async () => {
  const { e } = await setup()
  await e.ingest({ text: SOL_CALL, source: 'Alpha Desk', postedAt: T0 })
  const v = await e.voice('Skip this one.')
  assert.equal(v.kind, 'idle')
})

test('price through TP1 closes the paper trade and journals the win', async () => {
  const { e, journal, market } = await setup()
  await e.ingest({ text: SOL_CALL, source: 'Alpha Desk', postedAt: T0 })
  await e.input('tap')
  await e.input('tap')
  market.mids = async () => ({ SOL: 73.1, BTC: 61000 })
  await e.tick()
  await new Promise((r) => setImmediate(r))
  assert.equal(e.book.open().length, 0)
  assert.match(journal.at(-1), /✅ SOL long TP1 hit @ 73\.00 {2}\+\$1\.77 \(\+1\.25R\)/)
})

test('refuses a call whose stop already traded', async () => {
  const { e } = await setup({ mids: { SOL: 68 } })
  await e.ingest({ text: SOL_CALL, source: 'Alpha Desk', postedAt: T0 })
  const v = await e.input('tap')
  assert.equal(v.mode, 'browse')
  assert.match(v.footer, /past the stop/)
})

test('a forwarded old call is graded on candles and only feeds the scoreboard', async () => {
  const posted = T0 - 6 * 3_600_000
  const candles = {
    SOL: [
      { t: posted, o: 71, h: 71.2, l: 70.6, c: 70.7 },
      { t: posted + MIN, o: 70.7, h: 73.4, l: 70.6, c: 73.2 },
    ],
  }
  const { e } = await setup({ candles })
  const { call, reply } = await e.ingest({ text: SOL_CALL, source: 'Whale Calls', postedAt: posted, forwarded: true })
  assert.equal(call.historical, true)
  assert.equal(call.grade.status, 'tp')
  assert.match(reply, /TP1 hit first: \+0\.96R/)
  assert.equal(e.view().kind, 'idle')
  const [s] = e.scores()
  assert.equal(s.source, 'Whale Calls')
  assert.equal(s.wins, 1)
})

test('scores card posts the table to Telegram on tap', async () => {
  const { e, journal } = await setup()
  await e.input('next') // idle -> scores
  const v = await e.input('tap')
  assert.equal(v.kind, 'scores')
  await new Promise((r) => setImmediate(r))
  assert.match(journal[0], /Caller scores/)
})

test('chatter and invalid levels never reach the deck', async () => {
  const { e } = await setup()
  assert.deepEqual(await e.ingest({ text: 'gm, SOL looking strong', source: 'Alpha Desk' }), {})
  const { reply } = await e.ingest({ text: 'LONG $SOL entry 71 sl 74 tp 68', source: 'Alpha Desk' })
  assert.match(reply, /skipped it: levels do not fit a long/)
  assert.equal(e.view().kind, 'idle')
})

test('version only moves when the visible text changes', async () => {
  const { e } = await setup()
  const a = e.refresh().version
  assert.equal(e.refresh().version, a)
  await e.ingest({ text: SOL_CALL, source: 'Alpha Desk', postedAt: T0 })
  assert.ok(e.refresh().version > a)
})
