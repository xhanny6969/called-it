// Maps a short spoken phrase to an action. Push-to-talk on the glasses is for
// a few words ("paper fifty", "skip", "close it"), not dictation.

const WORDS = {
  ten: 10, twenty: 20, 'twenty five': 25, 'twenty-five': 25, thirty: 30, forty: 40, fifty: 50,
  'seventy five': 75, 'seventy-five': 75, hundred: 100, 'a hundred': 100, 'one hundred': 100,
  'hundred fifty': 150, 'one fifty': 150, 'a hundred fifty': 150, 'two hundred': 200,
  'two fifty': 250, 'two hundred fifty': 250, 'quarter': 25,
}

export function spokenAmount(text) {
  const t = text.toLowerCase().replace(/[$,]/g, '')
  const digits = /\b(\d{1,5}(?:\.\d+)?)\s*(k|bucks|dollars|usd)?\b/.exec(t)
  if (digits) return Number(digits[1]) * (digits[2] === 'k' ? 1000 : 1)
  // Longest phrase first so "two fifty" beats "fifty".
  for (const phrase of Object.keys(WORDS).sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${phrase}\\b`).test(t)) return WORDS[phrase]
  }
  return null
}

/** @returns {{type:'size',usd:number}|{type:'skip'|'close'|'confirm'|'cancel'|'score'|'positions'}|{type:'unknown'}} */
export function intentOf(text) {
  const t = String(text || '').toLowerCase().replace(/[.!?]/g, ' ').trim()
  if (!t) return { type: 'unknown' }
  if (/\b(cancel|never ?mind|back|no+pe?|don'?t)\b/.test(t)) return { type: 'cancel' }
  if (/\b(skip|pass|ignore|next one|not this)\b/.test(t)) return { type: 'skip' }
  if (/\b(close|exit|flatten|get me out|take (the )?profit|sell it|cut it)\b/.test(t)) return { type: 'close' }
  if (/\b(score|scores|scoreboard|leaderboard|callers?)\b/.test(t)) return { type: 'score' }
  if (/\b(positions?|my trades|open trades)\b/.test(t)) return { type: 'positions' }
  const usd = spokenAmount(t)
  if (usd) return { type: 'size', usd }
  if (/\b(yes|yeah|yep|confirm|do it|go|send it|paper it|demo it|buy it|place it|take it|ok(ay)?)\b/.test(t)) return { type: 'confirm' }
  return { type: 'unknown' }
}
