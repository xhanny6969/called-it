// Checks the Binance side of CalledIt without placing an order: public market
// data, and the demo account when a key is set in server/.env. Keys are never
// printed.
//
//   npm run check-binance

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBinance, createBinanceDemo, candlesSince } from '../src/binance.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'))

const market = createBinance()
const coins = await market.universe()
const mids = await market.mids()
const candles = await candlesSince(market, 'SOL', Date.now() - 6 * 3_600_000)
console.log(`market: ${coins.size} USDT perpetuals, ${Object.keys(mids).length} prices (BTC ${mids.BTC}), ${candles.length} SOL 1m candles for the last 6 h`)

const key = (process.env.BINANCE_API_KEY || '').trim()
const secret = (process.env.BINANCE_API_SECRET || '').trim()
if (!key || !secret) {
  console.log('demo: no BINANCE_API_KEY / BINANCE_API_SECRET in server/.env, so taps become paper trades')
  process.exit(0)
}
const demo = createBinanceDemo({ apiKey: key, apiSecret: secret })
try {
  const offset = await demo.syncTime()
  const hedge = await demo.hedgeMode()
  const balance = await demo.balance()
  const rules = await demo.rules()
  const open = (await demo.positions()).filter((p) => Number(p.positionAmt) !== 0)
  console.log(`demo: key accepted by ${demo.host}, ${hedge ? 'hedge' : 'one-way'} mode, ${balance} USDT available, ${rules.size} symbols, ${open.length} open positions, clock offset ${offset} ms`)
} catch (err) {
  console.log(`demo: ${demo.host} refused the key: ${err.message}`)
  process.exitCode = 1
}
