import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gradeCall, scoreboard, FILL_WINDOW_MS } from '../src/grade.js'
import { PaperBook } from '../src/paper.js'
import { callCard, lateNote } from '../src/views.js'

const T0 = Date.UTC(2026, 10, 25, 12, 0)
const MIN = 60_000
// Build 1m candles from [open, high, low, close] tuples.
const k = (rows) => rows.map(([o, h, l, c], i) => ({ t: T0 + i * MIN, T: T0 + (i + 1) * MIN - 1, o, h, l, c }))

const long = { side: 'long', coin: 'SOL', entry: { lo: 70, hi: 71 }, sl: 68, tps: [74, 77] }
const short = { side: 'short', coin: 'BTC', entry: { lo: 61000, hi: 61500 }, sl: 62500, tps: [59000] }

test('long fills in the zone, then TP1 trades: a win measured in R', () => {
  const g = gradeCall(long, T0, k([[72, 72.5, 71.8, 72], [71.9, 72, 70.6, 70.8], [70.8, 74.2, 70.7, 74]]), T0 + 3 * MIN)
  assert.equal(g.status, 'tp')
  assert.equal(g.fill, 71) // limit at the zone top
  assert.equal(g.r, 1.0) // (74-71)/(71-68)
})

test('long fills, then the stop trades: a loss of -1R', () => {
  const g = gradeCall(long, T0, k([[70.5, 70.9, 70.2, 70.4], [70.4, 70.5, 67.9, 68.1]]))
  assert.equal(g.status, 'sl')
  assert.equal(g.fill, 70.5)
  assert.equal(g.r, -1)
})

test('stop and target inside one candle count as a loss', () => {
  const g = gradeCall(long, T0, k([[70.5, 74.5, 67.5, 72]]))
  assert.equal(g.status, 'sl')
  assert.equal(g.ambiguous, true)
})

test('zone never reached stays waiting, then expires after 48h', () => {
  const candles = k([[73, 73.5, 72.5, 73], [73, 73.4, 72.8, 73.1]])
  assert.equal(gradeCall(long, T0, candles, T0 + 2 * MIN).status, 'waiting')
  assert.equal(gradeCall(long, T0, candles, T0 + FILL_WINDOW_MS + MIN).status, 'expired')
})

test('short fills at the zone bottom or better and wins when price falls', () => {
  const g = gradeCall(short, T0, k([[60900, 61100, 60800, 61050], [61050, 61060, 58900, 59000]]))
  assert.equal(g.status, 'tp')
  assert.equal(g.fill, 61000)
  assert.equal(g.r, 1.33) // (61000-59000)/(62500-61000)
})

test('market entry fills at the first open and reports open R', () => {
  const g = gradeCall({ ...long, entry: null }, T0, k([[72, 72.4, 71.5, 72.2], [72.2, 72.8, 72.1, 72.75]]))
  assert.equal(g.status, 'open')
  assert.equal(g.fill, 72)
  assert.equal(g.r, 0.19) // (72.75-72)/(72-68)
})

test('scoreboard ranks sources by total R and ignores invalid calls', () => {
  const calls = [
    { source: 'Alpha', ticket: long, grade: { status: 'tp', r: 1.5 } },
    { source: 'Alpha', ticket: long, grade: { status: 'sl', r: -1 } },
    { source: 'Alpha', ticket: long, grade: { status: 'open', r: 0.2 } },
    { source: 'Degen', ticket: long, grade: { status: 'sl', r: -1 } },
    { source: 'Degen', ticket: { ...long, invalid: 'x' }, grade: null },
  ]
  const [a, d] = scoreboard(calls)
  assert.equal(a.source, 'Alpha')
  assert.equal(a.wins, 1)
  assert.equal(a.losses, 1)
  assert.equal(a.open, 1)
  assert.equal(a.totalR, 0.5)
  assert.equal(a.winRate, 0.5)
  assert.equal(d.calls, 1)
})

const call = { id: 'C1', source: 'Alpha', ticket: long }

test('paper: preview reports dollar risk and reward from the caller levels', () => {
  const book = new PaperBook()
  const c = book.check(call, 50, 70.5)
  assert.equal(c.ok, true)
  assert.equal(c.preview.risk, 1.77) // 50/70.5 * 2.5
  assert.equal(c.preview.reward, 2.48) // 50/70.5 * 3.5
  assert.equal(c.preview.chasePct, null)
})

test('paper: refuses entries past the stop, past TP1, above the cap, or twice', () => {
  const book = new PaperBook({ maxSize: 100 })
  assert.match(book.check(call, 50, 67.9).reason, /stop/)
  assert.match(book.check(call, 50, 74.1).reason, /TP1/)
  assert.match(book.check(call, 500, 70.5).reason, /cap/)
  assert.equal(book.openFromCall(call, 50, 70.5).ok, true)
  assert.match(book.check(call, 50, 70.5).reason, /already/)
})

test('paper: chasing above the zone is reported in percent', () => {
  const c = new PaperBook().check(call, 50, 72)
  assert.equal(c.preview.chasePct, 1.41)
})

test('paper: mark closes at the stop and at TP1, manual close books PnL', () => {
  const book = new PaperBook()
  const a = book.openFromCall(call, 50, 70.5).position
  const b = book.openFromCall({ id: 'C2', source: 'Alpha', ticket: { ...long, tps: [72] } }, 100, 70.5).position
  assert.deepEqual(book.mark({ SOL: 71 }), [])
  const closed = book.mark({ SOL: 72.1 })
  assert.equal(closed.length, 1)
  assert.equal(closed[0].id, b.id)
  assert.equal(closed[0].closeReason, 'tp1')
  assert.equal(book.pnl(a, 71.5).usd, 0.71)
  const done = book.close(a.id, 71.5)
  assert.equal(done.position.pnlUsd, 0.71)
  assert.equal(book.open().length, 0)
})

test('a call already through its stop or TP1 is shown as too late, with no paper action', () => {
  assert.equal(lateNote(long, 67.5), 'already past the stop')
  assert.equal(lateNote(long, 74.2), 'TP1 already hit')
  assert.equal(lateNote(long, 70.5), null)
  assert.equal(lateNote(short, 62600), 'already past the stop')
  const call = { source: 'Desk', postedAt: T0, ticket: long }
  const late = callCard(call, { mid: 67.5, score: null, size: 50, now: T0 + MIN, pos: '' })
  assert.match(late.body, /already past the stop, too late/)
  assert.doesNotMatch(late.footer, /paper \$/)
  const live = callCard(call, { mid: 70.5, score: null, size: 50, now: T0 + MIN, pos: '' })
  assert.match(live.footer, /tap  paper \$50/)
})
