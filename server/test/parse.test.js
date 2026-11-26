import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseCall, toNumber } from '../src/parse.js'

const meta = JSON.parse(readFileSync(new URL('./fixtures/meta.json', import.meta.url), 'utf8'))
const universe = new Set(meta.universe.map((u) => u.name))
const mids = { BTC: 60800, ETH: 1700, SOL: 71, HYPE: 61.4, kPEPE: 0.0089, WIF: 0.83, DOGE: 0.12 }
const p = (t) => parseCall(t, { universe, mids })

test('numbers: k suffix, thousands comma, decimal comma', () => {
  assert.equal(toNumber('61.2k'), 61200)
  assert.equal(toNumber('61,200'), 61200)
  assert.equal(toNumber('0,85'), 0.85)
  assert.equal(toNumber('142'), 142)
})

test('classic multi-line long with zone and two targets', () => {
  const t = p('🚀 LONG $SOL\nEntry: 70.2 - 70.8\nSL: 68.5\nTP1: 73 TP2: 75.5\nLev 5x')
  assert.equal(t.side, 'long')
  assert.equal(t.coin, 'SOL')
  assert.deepEqual(t.entry, { lo: 70.2, hi: 70.8 })
  assert.equal(t.sl, 68.5)
  assert.deepEqual(t.tps, [73, 75.5])
  assert.equal(t.leverage, 5)
  assert.equal(t.invalid, undefined)
})

test('pair notation, short, targets separated by slashes, stop label', () => {
  const t = p('#BTC/USDT SHORT\nEntry zone: 61200-61800\nTargets: 60500 / 59800 / 58000\nStop: 62600')
  assert.equal(t.side, 'short')
  assert.equal(t.coin, 'BTC')
  assert.deepEqual(t.entry, { lo: 61200, hi: 61800 })
  assert.equal(t.sl, 62600)
  assert.deepEqual(t.tps, [60500, 59800, 58000])
})

test('one-liner buy with lower-case labels', () => {
  const t = p('Buy ETH 1690-1705, sl 1650, tp 1760 1820')
  assert.equal(t.side, 'long')
  assert.equal(t.coin, 'ETH')
  assert.deepEqual(t.entry, { lo: 1690, hi: 1705 })
  assert.equal(t.sl, 1650)
  assert.deepEqual(t.tps, [1760, 1820])
})

test('lower-case coin with unlabeled entry and invalidation', () => {
  const t = p('sol long here 71.2, invalidation 68.9, targets 74/77')
  assert.equal(t.coin, 'SOL')
  assert.equal(t.side, 'long')
  assert.deepEqual(t.entry, { lo: 71.2, hi: 71.2 })
  assert.equal(t.sl, 68.9)
  assert.deepEqual(t.tps, [74, 77])
})

test('k-suffixed thousands', () => {
  const t = p('$BTC long 60.5k-60.9k sl 59.4k tp 62k / 63.5k')
  assert.deepEqual(t.entry, { lo: 60500, hi: 60900 })
  assert.equal(t.sl, 59400)
  assert.deepEqual(t.tps, [62000, 63500])
})

test('meme coin quoted per unit maps to the 1000x perp', () => {
  const t = p('$PEPE scalp long 0.0000088-0.0000090 sl 0.0000084 tp 0.0000097')
  assert.equal(t.coin, 'kPEPE')
  assert.equal(t.quoted, 'PEPE')
  assert.deepEqual(t.entry, { lo: 0.0088, hi: 0.009 })
  assert.equal(t.sl, 0.0084)
  assert.deepEqual(t.tps, [0.0097])
})

test('market entry (CMP)', () => {
  const t = p('HYPE short CMP\nSL 64\nTP 58 / 55')
  assert.equal(t.side, 'short')
  assert.equal(t.entry, null)
  assert.equal(t.sl, 64)
  assert.deepEqual(t.tps, [58, 55])
})

test('levels that contradict the side are flagged, not traded', () => {
  const t = p('LONG $SOL entry 71 sl 74 tp 68')
  assert.match(t.invalid, /long/)
})

test('chatter is not a call', () => {
  assert.equal(p('gm fam, SOL looking strong today'), null)
  assert.equal(p('Who is going long on BTC this weekend?'), null)
  assert.equal(p('sold my bags lol'), null)
})

test('a call without a stop is skipped', () => {
  assert.equal(p('LONG $SOL entry 70-71 tp 75'), null)
})

test('unknown ticker is skipped', () => {
  assert.equal(p('LONG $NOTACOINXYZ entry 1 sl 0.9 tp 1.2'), null)
})

test('numbered lists, "Target 1:" labels and risk/reward ratios are not read as prices', () => {
  const vip = p('🔴 SHORT\n\n👉 Strategy : Swing Strategy\n\n#SOL/USDT\n\nEntry :\n\n1) 105.5100\n2) 108.6753\n\nTargets :\n\n1) 104.8920\n2) 102.6647\n3) 100.4375\n4) 98.21031\n\nStop : 112.1571\n\nLeverage : 10x (isolated)')
  assert.deepEqual([vip.side, vip.coin, vip.entry, vip.sl, vip.tps, vip.invalid], ['short', 'SOL', { lo: 105.51, hi: 108.6753 }, 112.1571, [104.892, 102.6647, 100.4375, 98.21031], undefined])
  const labelled = p('#HYPE/USDT - Short🔴\n\nEntry: 65.125\nStop Loss: 65.66345\n\nTarget 1: 64.88874\nTarget 2: 64.62644\n\nLeverage: x16')
  assert.deepEqual([labelled.entry, labelled.sl, labelled.tps], [{ lo: 65.125, hi: 65.125 }, 65.66345, [64.88874, 64.62644]])
  const rrr = p('Sell Limit SOLUSD\n\n📍 Entry: 84.193\n🛑 SL: 88.047\n🎯 TP: 78.867\n⚡ RRR: 1:1.4')
  assert.deepEqual([rrr.side, rrr.coin, rrr.sl, rrr.tps], ['short', 'SOL', 88.047, [78.867]])
})

test('signal-strength scores, timeframes and "Target 10:" labels are not read as prices', () => {
  const scored = p('COIN: #XRPUSDT Leverage: 10x Direction: SHORT | Type: Swing Pullback ⭐ Signal Strength: 46.0/100 ➖➖➖ ENTRY: 1.113 - 1.117 TARGETS: 1.102 - 1.082 - 1.048 - 0.981 STOP LOSS: 1.204')
  assert.deepEqual([scored.side, scored.coin, scored.entry, scored.sl, scored.tps[0], scored.invalid], ['short', 'XRP', { lo: 1.113, hi: 1.117 }, 1.204, 1.102, undefined])
  const tf = p('🔴 TREND SNIPER SHORT!\n📊 Coin: RENDERUSDT.P\n⏱ TF: 15\n💰 Entry: 2.292\n🛑 SL: 2.3443\n🎯 TP1: 2.2554\n🎯 TP2: 2.1873')
  assert.deepEqual([tf.coin, tf.entry, tf.sl, tf.tps], ['RENDER', { lo: 2.292, hi: 2.292 }, 2.3443, [2.2554, 2.1873]])
  const ten = p('#SUI/USDT - Short🔴  Entry: 0.7613 Stop Loss: 0.83736  Target 1: 0.75199 Target 9: 0.73407 Target 10: 0.73158  Leverage: x31')
  assert.deepEqual(ten.tps, [0.75199, 0.73407, 0.73158])
})
