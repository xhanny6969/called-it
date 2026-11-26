// Pulls a public Telegram channel's history from its web preview (t.me/s/<name>)
// and shows which posts CalledIt can read as calls. Read-only, no login.
//
//   node tools/tg-history.mjs <channel> [days=200] [maxPages=60]
//
// Writes notes/tg_<channel>.json: [{ id, at, text, ticket }]

import { writeFile, mkdir } from 'node:fs/promises'
import { parseCall } from '../server/src/parse.js'

const [name, daysArg = '200', pagesArg = '60'] = process.argv.slice(2)
if (!name) { console.error('usage: node tools/tg-history.mjs <channel> [days] [maxPages]'); process.exit(1) }
const since = Date.now() - Number(daysArg) * 86_400_000

const unescape = (s) => s
  .replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&')

async function page(before) {
  const url = `https://t.me/s/${name}${before ? `?before=${before}` : ''}`
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) })
  const html = await res.text()
  const posts = []
  for (const block of html.split('<div class="tgme_widget_message_wrap').slice(1)) {
    const id = /data-post="[^/]+\/(\d+)"/.exec(block)?.[1]
    const at = /<time datetime="([^"]+)"/.exec(block)?.[1]
    const text = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1]
    if (id && at) posts.push({ id: Number(id), at: Date.parse(at), text: text ? unescape(text).trim() : '' })
  }
  return posts
}

const meta = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"meta"}' }).then((r) => r.json())
const universe = new Set(meta.universe.filter((u) => !u.isDelisted).map((u) => u.name))

const all = new Map()
let before = null
for (let i = 0; i < Number(pagesArg); i++) {
  const posts = await page(before)
  if (!posts.length) break
  for (const p of posts) all.set(p.id, p)
  const oldest = posts.reduce((a, b) => (a.id < b.id ? a : b))
  if (oldest.at < since || (before && oldest.id >= before)) break
  before = oldest.id
}
const posts = [...all.values()].filter((p) => p.at >= since).sort((a, b) => a.at - b.at)
for (const p of posts) p.ticket = p.text ? parseCall(p.text, { universe }) : null
const calls = posts.filter((p) => p.ticket && !p.ticket.invalid)

await mkdir(new URL('../notes/', import.meta.url), { recursive: true })
await writeFile(new URL(`../notes/tg_${name}.json`, import.meta.url), JSON.stringify(posts, null, 1))
const fmt = (t) => new Date(t).toISOString().slice(0, 10)
console.log(`${name}: ${posts.length} posts ${posts.length ? `${fmt(posts[0].at)} .. ${fmt(posts.at(-1).at)}` : ''}, ${calls.length} readable calls, ${posts.filter((p) => p.ticket?.invalid).length} rejected`)
for (const c of calls.slice(-5)) console.log(`  ${fmt(c.at)} ${c.ticket.side} ${c.ticket.coin} entry ${c.ticket.entry ? `${c.ticket.entry.lo}-${c.ticket.entry.hi}` : 'market'} sl ${c.ticket.sl} tp ${c.ticket.tps.join('/')}`)
