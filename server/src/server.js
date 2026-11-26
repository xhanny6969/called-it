// CalledIt backend: one process, no database.
//
//   Telegram (bot in your call channels, or forwards) ─┐
//                                                      ├─> Engine ──> /api/view (long-poll) ──> G2 app
//   Hyperliquid (prices, candles, read-only) ──────────┘      ^
//                                                               └── /api/input, /api/voice <── G2 app
//
// Secrets stay here. The glasses app only ever talks to this server.

import { createServer } from 'node:http'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Engine } from './engine.js'
import { createHyperliquid } from './hyperliquid.js'
import { createTelegram, pollForever } from './telegram.js'
import { transcribe, warmUp } from './stt.js'
import { journalScores, describeTicket } from './views.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'))

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
const STATE_FILE = process.env.STATE_FILE || join(ROOT, 'data', 'state.json')
const DEV = process.argv.includes('--dev') || process.env.DEV_ENDPOINTS === '1'
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

// ---- state ------------------------------------------------------------------

async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')) } catch { return {} }
}
const saved = await loadState()
const tgState = { offset: saved.telegram?.offset ?? 0, journalChatId: saved.telegram?.journalChatId ?? null, ownerId: saved.telegram?.ownerId ?? null }

let saveTimer = null
function persist() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    await mkdir(dirname(STATE_FILE), { recursive: true })
    const tmp = STATE_FILE + '.tmp'
    await writeFile(tmp, JSON.stringify({ ...engine.toJSON(), telegram: tgState }, null, 1))
    await rename(tmp, STATE_FILE)
  }, 400)
}

// ---- wiring -----------------------------------------------------------------

const hl = createHyperliquid({ network: process.env.HL_NETWORK || 'mainnet' })
const tg = process.env.TELEGRAM_BOT_TOKEN ? createTelegram({ token: process.env.TELEGRAM_BOT_TOKEN }) : null

const engine = new Engine({
  hl,
  journal: async (text) => {
    if (!tg || !tgState.journalChatId) { log('journal (no Telegram chat yet):', text.split('\n')[0]); return }
    await tg.sendMessage(tgState.journalChatId, text)
  },
}, saved)
engine.on('persist', persist)
engine.on('warn', (m) => log('warn', m))
engine.on('view', ({ version, reason }) => { wake(); if (reason !== 'tick') log(`view v${version} (${reason})`) })

await engine.init()
log(`Hyperliquid ${hl.network}: ${engine.universe.size} perps, ${Object.keys(engine.mids).length} prices`)
setInterval(() => engine.tick(), Number(process.env.TICK_MS || 3000))
warmUp().then((ok) => log(ok ? 'speech-to-text ready (Whisper, local)' : 'speech-to-text unavailable: run npm run fetch-model'))

// ---- Telegram ---------------------------------------------------------------

const HELP = [
  'CalledIt reads trade calls and puts them on your Even G2.',
  '',
  '• Add me as an admin to your call channel (or a group with privacy off): new calls go straight to your glasses.',
  '• Forward old calls here: I grade each one on Hyperliquid candles and keep a score per caller.',
  '• Paper trades you take on the glasses are logged in this chat.',
  '',
  '/score  caller scoreboard',
  '/size 100  default paper size in USD',
].join('\n')

async function onTelegram(msg) {
  if (msg.chatType === 'private') {
    if (tgState.ownerId && msg.fromId !== tgState.ownerId) {
      await tg.sendMessage(msg.chatId, 'This CalledIt bot belongs to someone else.')
      return
    }
    if (!tgState.ownerId && msg.command?.[0] === '/start') {
      tgState.ownerId = msg.fromId
      tgState.journalChatId = msg.chatId
      persist()
    }
  }
  if (msg.command) {
    const [cmd, arg] = msg.command
    if (cmd === '/start' || cmd === '/help') return void (await tg.sendMessage(msg.chatId, HELP))
    if (cmd === '/score') return void (await tg.sendMessage(msg.chatId, journalScores(engine.scores())))
    if (cmd === '/size') {
      const n = Number(arg)
      if (n > 0 && n <= engine.book.maxSize) { engine.setDefaultSize(n); await tg.sendMessage(msg.chatId, `Default paper size: $${n}`) }
      else await tg.sendMessage(msg.chatId, `Usage: /size 50 (max $${engine.book.maxSize})`)
      return
    }
  }
  const { call, reply } = await engine.ingest(msg)
  if (call) log(`call ${call.id} from ${call.source}: ${describeTicket(call.ticket)}${call.historical ? ' [graded]' : ''}`)
  // Answer in the private chat only; never post into someone's channel or group.
  if (msg.chatType === 'private') {
    await tg.sendMessage(msg.chatId, reply ?? 'Not a call I can read. I need a side, a coin listed on Hyperliquid, a stop and a target.', { reply_to_message_id: msg.msgId })
  }
}

if (tg) {
  const me = await tg.getMe()
  log(`Telegram: @${me.username}${tgState.journalChatId ? ', journal chat set' : ', send /start to the bot to link your journal'}`)
  const cursor = { get offset() { return tgState.offset }, set offset(v) { tgState.offset = v; persist() } }
  pollForever({ tg, cursor, onMessage: onTelegram, onError: (e) => log('telegram', e.message) })
} else {
  log('Telegram: off (set TELEGRAM_BOT_TOKEN in server/.env)')
}

// ---- HTTP -------------------------------------------------------------------

const waiters = new Set()
function wake() {
  for (const w of waiters) w()
  waiters.clear()
}

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function body(req, limit = 4_000_000) {
  const chunks = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > limit) throw Object.assign(new Error('body too large'), { status: 413 })
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

const view = () => ({ ...engine.view(), version: engine.version })

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {})
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, telegram: Boolean(tg), journal: Boolean(tgState.journalChatId) })

    if (url.pathname === '/api/view' && req.method === 'GET') {
      // Long-poll: answer as soon as the view moves past `since`, or after 20 s.
      const since = Number(url.searchParams.get('since') || 0)
      if (engine.version > since) return send(res, 200, view())
      const done = () => { clearTimeout(timer); waiters.delete(done); if (!res.writableEnded) send(res, 200, view()) }
      const timer = setTimeout(done, 20_000)
      waiters.add(done)
      req.on('close', () => { clearTimeout(timer); waiters.delete(done) })
      return
    }

    if (url.pathname === '/api/input' && req.method === 'POST') {
      const { action } = JSON.parse((await body(req, 10_000)).toString() || '{}')
      if (!['tap', 'next', 'prev'].includes(action)) return send(res, 400, { error: 'action must be tap, next or prev' })
      const v = await engine.input(action)
      return send(res, 200, { ...v, version: engine.version })
    }

    if (url.pathname === '/api/voice' && req.method === 'POST') {
      const pcm = await body(req)
      const t0 = Date.now()
      const text = await transcribe(pcm)
      log(`voice ${pcm.length} bytes -> "${text}" in ${Date.now() - t0} ms`)
      const v = await engine.voice(text)
      return send(res, 200, { text, ...v, version: engine.version })
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      return send(res, 200, { calls: engine.calls, positions: engine.book.positions, scores: engine.scores(), settings: engine.settings })
    }

    if (DEV && url.pathname === '/api/dev/message' && req.method === 'POST') {
      const m = JSON.parse((await body(req, 20_000)).toString())
      const r = await engine.ingest({ text: m.text, source: m.source || 'Dev feed', postedAt: m.postedAt, forwarded: Boolean(m.forwarded), chatId: m.chatId ?? 'dev' })
      return send(res, 200, { call: r.call ?? null, reply: r.reply ?? null })
    }

    send(res, 404, { error: 'not found' })
  } catch (err) {
    log('http', req.method, url.pathname, err.message)
    send(res, err.status || 500, { error: err.message })
  }
})

server.listen(PORT, HOST, () => log(`CalledIt server on http://${HOST}:${PORT}${DEV ? ' (dev endpoints on)' : ''}`))
