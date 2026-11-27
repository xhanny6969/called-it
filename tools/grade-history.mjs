// Grades every call in saved channel histories (notes/tg_<channel>.json, from
// tools/tg-history.mjs) on Binance USD-M candles, with the same parser and
// grader the bot uses, and prints the per-channel table for the README.
//
//   node tools/grade-history.mjs cryptosignals0rg TradingGainX ...
//
// A call posted again later (same coin, side, stop and TP1, as in result
// updates that quote the original levels) counts once, from its first post.
// Writes notes/graded-<date>.json with every call and its grade.

import { readFile, writeFile } from 'node:fs/promises'
import { parseCall } from '../server/src/parse.js'
import { gradeCall, scoreboard } from '../server/src/grade.js'
import { createBinance, candlesSince } from '../server/src/binance.js'

const names = process.argv.slice(2)
if (!names.length) { console.error('usage: node tools/grade-history.mjs <channel> [channel...]'); process.exit(1) }

const market = createBinance({ weightPerMinute: 1800 })
const universe = await market.universe()
const now = Date.now()

const rows = []
const skipped = {}
for (const name of names) {
  const posts = JSON.parse(await readFile(new URL(`../notes/tg_${name}.json`, import.meta.url), 'utf8'))
  posts.sort((a, b) => a.at - b.at)
  const s = (skipped[name] = { posts: posts.length, notACall: 0, invalid: 0, unlisted: 0, reposts: 0 })
  const seen = new Set()
  for (const p of posts) {
    const t = p.text ? parseCall(p.text, { universe }) : null
    if (!t) {
      const any = p.text ? parseCall(p.text, {}) : null // without a market list: was it a call at all?
      if (any && !any.invalid) s.unlisted++
      else s.notACall++
      continue
    }
    if (t.invalid) { s.invalid++; continue }
    const key = [t.coin, t.side, t.sl, t.tps[0]].join('|')
    if (seen.has(key)) { s.reposts++; continue }
    seen.add(key)
    rows.push({ source: `@${name}`, postedAt: p.at, postId: p.id, ticket: t })
  }
}
rows.sort((a, b) => a.postedAt - b.postedAt) // the oldest call per coin fills the cache for the rest

let done = 0
for (const r of rows) {
  try {
    const candles = await candlesSince(market, r.ticket.coin, r.postedAt, now)
    r.grade = candles ? gradeCall(r.ticket, r.postedAt, candles, now) : { status: 'too_old' }
  } catch (err) {
    r.grade = { status: 'error', error: err.message }
  }
  if (++done % 25 === 0) console.error(`graded ${done}/${rows.length}`)
}

const day = (t) => new Date(t).toISOString().slice(0, 10)
const out = { gradedAt: new Date(now).toISOString(), market: 'Binance USD-M (fapi.binance.com klines)', skipped, calls: rows }
await writeFile(new URL(`../notes/graded-${day(now)}.json`, import.meta.url), JSON.stringify(out, null, 1))

const calls = rows.map((r) => ({ source: r.source, ticket: r.ticket, grade: r.grade }))
console.log(`${rows.length} calls from ${names.length} channels, posted ${day(rows[0].postedAt)} to ${day(rows.at(-1).postedAt)}, graded ${day(now)} on Binance USD-M candles\n`)
console.log('| Channel | TP1 first | Stop first | Still open | TP1 rate | Avg R | Total R |')
console.log('|---|---|---|---|---|---|---|')
for (const s of scoreboard(calls)) {
  const closed = s.wins + s.losses
  console.log(`| ${s.source} | ${s.wins} | ${s.losses} | ${s.open} | ${closed ? Math.round((s.wins / closed) * 100) + '%' : 'n/a'} | ${s.avgR ?? 'n/a'} | ${s.totalR} |`)
}
const by = (st) => rows.filter((r) => r.grade?.status === st).length
console.log(`\nexpired (entry never reached in 48 h): ${by('expired')}, waiting: ${by('waiting')}, ambiguous candles counted as losses: ${rows.filter((r) => r.grade?.ambiguous).length}, errors: ${by('error')}, too old: ${by('too_old')}`)
for (const [n, s] of Object.entries(skipped)) console.log(`@${n}: ${s.posts} posts, ${s.reposts} reposts of an earlier call, ${s.notACall} not a call, ${s.invalid} rejected levels, ${s.unlisted} calls on coins Binance does not list`)
