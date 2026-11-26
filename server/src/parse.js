// Turns a free-form Telegram trade call into a structured ticket.
//
//   "🚀 LONG $SOL  Entry 142-143.5  SL 138  TP 150 / 158"
//   -> { side: 'long', coin: 'SOL', entry: { lo: 142, hi: 143.5 }, sl: 138, tps: [150, 158] }
//
// Rule-based on purpose: it runs on every message in every watched chat, so it
// has to be cheap, deterministic and testable, and a call it cannot read is
// better skipped than guessed.

const SIDE_WORDS = [
  [/\b(long|longs|longing|buy|bought|bid)\b|🟢|📈/i, 'long'],
  [/\b(short|shorts|shorting|sell|sold)\b|🔴|📉/i, 'short'],
]

// Words that look like tickers but are never the coin being called.
const STOP_TICKERS = new Set([
  'LONG', 'SHORT', 'BUY', 'SELL', 'ENTRY', 'SL', 'TP', 'TPS', 'STOP', 'LOSS', 'TARGET', 'TARGETS',
  'USDT', 'USDC', 'USD', 'PERP', 'PERPS', 'LEV', 'LEVERAGE', 'CMP', 'NOW', 'ZONE', 'SPOT', 'DCA',
  'NFA', 'DYOR', 'ATH', 'ATL', 'RR', 'PNL', 'ROI', 'BE', 'TF', 'HTF', 'LTF', 'X', 'AND', 'THE',
  'FOR', 'ON', 'AT', 'IN', 'TO', 'OF', 'OR', 'IT', 'IS', 'A', 'I', 'ME', 'MY', 'UP', 'GO', 'NEW',
  'SIGNAL', 'CALL', 'SCALP', 'SWING', 'TRADE', 'SETUP', 'HERE', 'LIMIT', 'MARKET', 'OPEN', 'CLOSE',
])

export function toNumber(text) {
  if (text == null) return NaN
  let s = String(text).trim().toLowerCase()
  let mult = 1
  if (s.endsWith('k')) { mult = 1000; s = s.slice(0, -1).trim() }
  // "61,200" is a thousands separator; "0,85" is a decimal comma.
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '')
  else s = s.replace(',', '.')
  const n = Number(s)
  return Number.isFinite(n) ? n * mult : NaN
}

/** Maps a quoted ticker onto a Hyperliquid perp; PEPE is listed as kPEPE (1000 units). */
// Ordinary English words that are also tickers: only $NOT / #NOT / NOTUSDT / NOT in capitals count.
const LOWER_WORDS = new Set(['not', 'near', 'one', 'any', 'all', 'win', 'key', 'max', 'hot', 'sun', 'ray', 'well', 'just', 'now', 'new', 'can', 'get', 'are', 'io', 'me', 'pump', 'move', 'meme', 'zero', 'fun', 'ace', 'big', 'mask', 'gas', 'ark', 'ai', 'blur', 'core', 'dog', 'cat'])

export function resolveCoin(sym, universe) {
  if (!universe) return { coin: sym, scale: 1, quoted: sym }
  if (universe.has(sym)) return { coin: sym, scale: 1, quoted: sym }
  if (universe.has('k' + sym)) return { coin: 'k' + sym, scale: 1000, quoted: sym }
  if (sym.startsWith('1000') && universe.has('k' + sym.slice(4))) {
    return { coin: 'k' + sym.slice(4), scale: 1, quoted: sym }
  }
  return null
}

export function findCoin(text, universe) {
  const candidates = []
  const push = (raw, index, strong) => {
    const sym = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!sym || STOP_TICKERS.has(sym)) return
    candidates.push({ sym, index, strong })
  }
  for (const m of text.matchAll(/[$#]([A-Za-z0-9]{2,15})/g)) push(m[1], m.index, true)
  for (const m of text.matchAll(/\b([A-Z0-9]{2,15})\s*[/-]?\s*(?:USDT|USDC|USD|PERP)\b/gi)) push(m[1], m.index, true)
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]{1,9})\b/g)) push(m[1], m.index, false)
  // Lower-case names ("sol long here") count only when the market lists them.
  for (const m of text.matchAll(/\b([a-z][a-z0-9]{1,9})\b/g)) {
    if (LOWER_WORDS.has(m[1])) continue
    if (universe?.has(m[1].toUpperCase())) push(m[1], m.index, false)
  }
  candidates.sort((a, b) => (b.strong - a.strong) || (a.index - b.index))
  for (const c of candidates) {
    const resolved = resolveCoin(c.sym, universe)
    if (resolved) return resolved
  }
  return null
}

function findSide(text) {
  let best = null
  for (const [re, side] of SIDE_WORDS) {
    const m = re.exec(text)
    if (m && (!best || m.index < best.index)) best = { side, index: m.index }
  }
  return best?.side ?? null
}

// One pass over the message: labels switch the "slot", numbers fill it.
const TOKEN = new RegExp(
  [
    String.raw`(?<sl>\bs\/l\b|\bsl\b|\bstop[\s-]?loss\b|\bstoploss\b|\bstop\b|\binvalidation\b|\binvalid(?:ated)?\b)`,
    String.raw`(?<tp>\btp\d?\b|\btps\b|\bt\/p\b|\btake[\s-]?profits?\b|\btargets?\b|\btgts?\b|\btg\d\b)`,
    String.raw`(?<entry>\bentry\s*zone\b|\b(?:buy|sell)\s*zone\b|\bentries\b|\bentry\b|\benter\b|\bzone\b|\bin\s+at\b|\bopened?\s+at\b|\blimit\b|@)`,
    String.raw`(?<side>\blong\b|\bshort\b|\bbuy\b|\bsell\b|\blonging\b|\bshorting\b)`,
    String.raw`(?<market>\bcmp\b|\bmarket\b|\bmkt\b)`,
    String.raw`(?<num>(?<![a-z0-9.$#])\d+(?:[.,]\d+)*(?:\s?k(?![a-z]))?(?![a-z0-9%]))`,
  ].join('|'),
  'gi',
)

export function extractLevels(lower) {
  // Leverage ("5x", "x10", "lev 20") and tickers are not price levels.
  const clean = lower
    // List numbering and level labels are not prices: "1) 105.51", "target 1: 0.059", "tp 2 - 64.6", "1️⃣".
    .replace(/[0-9]\ufe0f?\u20e3/g, ' ')
    .replace(/\b(tp|targets?|take ?profit)\s?[1-9]\d?\s*(?::|\))/g, '$1 ')
    .replace(/\b(tp|targets?|take ?profit)\s?[1-9]\s*(?:\.(?=\s)|\s[-–]\s)/g, '$1 ')
    // Scores and timeframes are not prices: "signal strength 46.0/100", "tf: 15".
    .replace(/\d+(?:\.\d+)?\s*\/\s*100\b/g, ' ')
    .replace(/\b(?:tf|timeframe|time ?frame)\s*[:=]?\s*\d+\s*[a-z]?\b/g, ' ')
    .replace(/(^|[\s:(\[])\d{1,2}\)\s/g, '$1 ')
    // Risk/reward ratios are not prices: "RRR 1:1.4", "R:R 1/3".
    .replace(/\b(?:r{2,3}|r:r|r\/r|risk ?(?:to|:|\/)? ?reward)\s*[:=]?\s*\d+(?:\.\d+)?\s*[:/]\s*\d+(?:\.\d+)?/g, ' ')
    .replace(/\blev(?:erage)?\s*[:=]?\s*\d{1,3}\s*x?\b/g, ' ')
    .replace(/\b\d{1,3}\s?x\b|\bx\s?\d{1,3}\b/g, ' ')
    .replace(/[$#][a-z0-9]+/g, ' ')
  const slots = { entry: [], sl: [], tp: [] }
  let slot = null
  let market = false
  for (const m of clean.matchAll(TOKEN)) {
    const g = m.groups
    if (g.sl) slot = 'sl'
    else if (g.tp) slot = 'tp'
    else if (g.entry) slot = 'entry'
    else if (g.side) { if (slot === null) slot = 'entry' }
    else if (g.market) { market = true; if (slot === null) slot = 'entry' }
    else if (g.num && slot) slots[slot].push(toNumber(g.num))
  }
  return { ...slots, market }
}

/**
 * Parses one message. Returns null when the message is not a trade call.
 * @param {string} text
 * @param {{ universe?: Set<string>, mids?: Record<string, number> }} ctx
 */
export function parseCall(text, ctx = {}) {
  if (!text || text.length > 1500) return null
  const flat = text.replace(/\u00a0/g, ' ').replace(/[*_`]/g, '')
  const side = findSide(flat)
  if (!side) return null
  const coinInfo = findCoin(flat, ctx.universe)
  if (!coinInfo) return null

  const lv = extractLevels(flat.toLowerCase())
  const sl = lv.sl.find(Number.isFinite)
  const entryNums = lv.entry.filter(Number.isFinite)
  const tps = [...new Set(lv.tp.filter(Number.isFinite))].filter((n) => n !== sl)
  if (!Number.isFinite(sl) || !tps.length) return null
  if (!entryNums.length && !lv.market) return null

  const s = (n) => +(n * coinInfo.scale).toPrecision(8)
  const entry = entryNums.length
    ? { lo: s(Math.min(...entryNums)), hi: s(Math.max(...entryNums)) }
    : null // market / "CMP"

  const ticket = {
    side,
    coin: coinInfo.coin,
    quoted: coinInfo.quoted,
    entry,
    sl: s(sl),
    tps: tps.map(s).sort((a, b) => (side === 'long' ? a - b : b - a)),
    leverage: leverageOf(flat.toLowerCase()),
  }
  const problem = sanityCheck(ticket, ctx.mids?.[ticket.coin])
  return problem ? { ...ticket, invalid: problem } : ticket
}

function leverageOf(lower) {
  const m = /(?:\b(\d{1,3})\s?x\b|\bx\s?(\d{1,3})\b|lev(?:erage)?\s*[:=]?\s*(\d{1,3}))/.exec(lower)
  const v = m && Number(m[1] || m[2] || m[3])
  return v && v <= 200 ? v : null
}

/** Long: SL < entry < TP. Short: TP < entry < SL. Levels far from the market are a misread. */
export function sanityCheck(t, mid) {
  const ref = t.entry ? (t.entry.lo + t.entry.hi) / 2 : mid
  const tp1 = t.tps[0]
  if (Number.isFinite(ref)) {
    if (t.side === 'long' && !(t.sl < ref && tp1 > ref)) return 'levels do not fit a long'
    if (t.side === 'short' && !(t.sl > ref && tp1 < ref)) return 'levels do not fit a short'
  }
  if (Number.isFinite(mid) && Number.isFinite(ref) && (ref / mid > 3 || mid / ref > 3)) {
    return 'entry is nowhere near the market price'
  }
  return null
}
