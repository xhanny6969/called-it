// The CalledIt state machine. Everything the glasses show and every action
// they take goes through here, so it is testable without Telegram, without
// the network and without glasses.

import { EventEmitter } from 'node:events'
import { parseCall } from './parse.js'
import { gradeCall, scoreboard } from './grade.js'
import { candlesSince } from './hyperliquid.js'
import { PaperBook } from './paper.js'
import { intentOf } from './intent.js'
import * as V from './views.js'

const LIVE_WINDOW_MS = 24 * 3_600_000 // calls older than this leave the deck
const HISTORICAL_AFTER_MS = 15 * 60_000 // a forward older than this is graded, not traded
const FLASH_MS = 4_000

export class Engine extends EventEmitter {
  /**
   * @param {object} deps
   * @param {ReturnType<import('./hyperliquid.js').createHyperliquid>} deps.hl
   * @param {(text: string) => Promise<unknown>} [deps.journal]  posts to the user's Telegram
   * @param {() => number} [deps.now]
   * @param {object} [state]  persisted state from a previous run
   */
  constructor({ hl, journal = async () => {}, now = Date.now }, state = {}) {
    super()
    this.hl = hl
    this.journal = journal
    this.now = now
    this.calls = state.calls ?? []
    this.book = new PaperBook(state.book)
    this.settings = { defaultSize: 50, ...state.settings }
    this.chats = new Map(state.chats ?? []) // chatId -> title, for "watching N chats"
    this.seq = state.seq ?? 1
    this.universe = null
    this.mids = {}
    this.ui = { cardId: null, mode: 'browse', size: null, flash: null, preview: null }
    this.version = 1
    this.lastView = ''
    this.lastRegrade = 0
  }

  toJSON() {
    return { calls: this.calls, book: this.book.toJSON(), settings: this.settings, chats: [...this.chats], seq: this.seq }
  }

  async init() {
    this.universe = await this.hl.universe()
    this.mids = await this.hl.mids()
  }

  // ---- ingest ---------------------------------------------------------------

  /**
   * One incoming message (Telegram or the dev endpoint).
   * @returns {Promise<{call?: object, reply?: string}>}
   */
  async ingest({ text, source, chatId = null, msgId = null, postedAt, forwarded = false }) {
    if (chatId != null && source && !forwarded) this.chats.set(String(chatId), source)
    const ticket = parseCall(text, { universe: this.universe, mids: this.mids })
    if (!ticket) return {}
    const now = this.now()
    const call = {
      id: `C${this.seq++}`,
      source,
      chatId,
      msgId,
      postedAt: postedAt ?? now,
      receivedAt: now,
      text: text.slice(0, 600),
      ticket,
      grade: null,
      historical: forwarded && now - (postedAt ?? now) > HISTORICAL_AFTER_MS,
      dismissed: false,
    }
    this.calls.push(call)
    if (!ticket.invalid) await this.regrade(call)
    if (!call.historical && !ticket.invalid && this.ui.mode === 'browse') this.ui.cardId = call.id
    this.changed('call')
    return { call, reply: this.ingestReply(call) }
  }

  ingestReply(call) {
    const t = call.ticket
    if (t.invalid) return `⚠️ Read a ${t.side} on ${t.coin} but skipped it: ${t.invalid}.`
    if (call.historical) {
      return `📊 ${V.describeTicket(t)}\nFrom ${call.source}, ${V.ago(this.now() - call.postedAt)}: ${V.describeGrade(call.grade)}`
    }
    return `👓 On your glasses: ${V.describeTicket(t)}`
  }

  async regrade(call) {
    try {
      const candles = await candlesSince(this.hl, call.ticket.coin, call.postedAt, this.now())
      if (candles) call.grade = gradeCall(call.ticket, call.postedAt, candles, this.now())
    } catch (err) {
      this.emit('warn', `grading ${call.id} failed: ${err.message}`)
    }
  }

  // ---- clock ------------------------------------------------------------------

  /** Called every few seconds: new prices, stops/targets, periodic regrade. */
  async tick() {
    try {
      this.mids = await this.hl.mids()
    } catch (err) {
      this.emit('warn', `prices failed: ${err.message}`)
      return
    }
    for (const p of this.book.mark(this.mids, this.now())) {
      this.flash(`${p.closeReason === 'stop' ? 'Stop hit' : 'TP1 hit'}: ${p.coin} ${V.usd(p.pnlUsd)}`)
      this.safeJournal(V.journalClose(p, this.book.pnl(p)))
      this.changed('closed')
    }
    if (this.now() - this.lastRegrade > 60_000) {
      this.lastRegrade = this.now()
      const active = this.calls.filter((c) => !c.ticket.invalid && (!c.grade || ['waiting', 'open'].includes(c.grade.status)))
      const before = JSON.stringify(active.map((c) => c.grade ?? null))
      for (const c of active.slice(-40)) await this.regrade(c)
      // Grades that moved must reach the state file, or a restart regrades from scratch.
      if (JSON.stringify(active.map((c) => c.grade ?? null)) !== before) this.emit('persist')
    }
    this.refresh()
  }

  // ---- deck -------------------------------------------------------------------

  liveCalls() {
    const now = this.now()
    const taken = new Set(this.book.positions.map((p) => p.callId))
    return this.calls
      .filter((c) => !c.historical && !c.dismissed && !c.ticket.invalid && !taken.has(c.id))
      .filter((c) => now - c.postedAt < LIVE_WINDOW_MS)
      .filter((c) => !c.grade || ['waiting', 'open'].includes(c.grade.status))
      .sort((a, b) => b.postedAt - a.postedAt)
  }

  deck() {
    const cards = [
      ...this.liveCalls().map((c) => ({ id: c.id, kind: 'call', call: c })),
      ...this.book.open().map((p) => ({ id: p.id, kind: 'position', pos: p })),
      { id: 'scores', kind: 'scores' },
    ]
    if (cards.length === 1) cards.unshift({ id: 'idle', kind: 'idle' })
    return cards
  }

  current() {
    const deck = this.deck()
    let i = deck.findIndex((c) => c.id === this.ui.cardId)
    if (i < 0) i = 0
    this.ui.cardId = deck[i].id
    return { deck, i, card: deck[i] }
  }

  scores() {
    return scoreboard(this.calls)
  }

  view() {
    const now = this.now()
    const { deck, i, card } = this.current()
    const pos = deck.length > 1 ? `   ${i + 1}/${deck.length}` : ''
    let v
    if (this.ui.mode === 'confirm' && this.ui.preview && card.kind === 'call') {
      v = V.confirmCard(this.ui.preview, card.call)
    } else if (this.ui.mode === 'close' && card.kind === 'position') {
      const mid = this.mids[card.pos.coin]
      v = V.closeCard(card.pos, { mid, pnl: this.book.pnl(card.pos, mid) })
    } else if (card.kind === 'call') {
      const score = this.scores().find((s) => s.source === card.call.source)
      v = V.callCard(card.call, { mid: this.mids[card.call.ticket.coin], score, size: this.size(), now, pos })
    } else if (card.kind === 'position') {
      const mid = this.mids[card.pos.coin]
      v = V.positionCard(card.pos, { mid, pnl: this.book.pnl(card.pos, mid), now, pos })
    } else if (card.kind === 'scores') {
      const graded = this.calls.filter((c) => ['tp', 'sl'].includes(c.grade?.status)).length
      v = V.scoreCard(this.scores(), { pos, graded })
    } else {
      v = V.idleCard({ chats: this.chats.size, last: this.lastLine() })
    }
    if (this.ui.flash && this.ui.flash.until > now) v = { ...v, footer: this.ui.flash.text }
    return { ...v, kind: card.kind, cardId: card.id, mode: this.ui.mode }
  }

  lastLine() {
    const last = [...this.calls].reverse().find((c) => c.grade && ['tp', 'sl'].includes(c.grade.status))
    return last ? `${last.ticket.coin} ${last.ticket.side} from ${last.source}, ${V.describeGrade(last.grade)}` : null
  }

  size() {
    return this.ui.size ?? this.settings.defaultSize
  }

  // ---- input ------------------------------------------------------------------

  /** @param {'tap'|'next'|'prev'} action */
  async input(action) {
    const { deck, i, card } = this.current()
    const mode = this.ui.mode
    if (action === 'next' || action === 'prev') {
      if (mode !== 'browse') return this.cancel()
      const j = (i + (action === 'next' ? 1 : -1) + deck.length) % deck.length
      this.ui.cardId = deck[j].id
      this.ui.size = null
      this.ui.flash = null // a message about the previous card would mislead on the next one
      return this.changed('nav')
    }
    if (action !== 'tap') return this.view()
    if (card.kind === 'call') return mode === 'confirm' ? this.confirmPaper(card.call) : this.startPaper(card.call)
    if (card.kind === 'position') return mode === 'close' ? this.confirmClose(card.pos) : this.startClose()
    if (card.kind === 'scores') return this.postScores()
    return this.view()
  }

  /** Push-to-talk: the transcript is already text here. */
  async voice(transcript) {
    const intent = intentOf(transcript)
    const { card } = this.current()
    const heard = transcript ? `heard "${transcript.slice(0, 40)}"` : 'heard nothing'
    switch (intent.type) {
      case 'size':
        if (card.kind !== 'call') break
        this.ui.size = intent.usd
        await this.startPaper(card.call)
        this.flash(`${heard} → $${intent.usd}, tap to confirm`)
        return this.view()
      case 'confirm':
        if (this.ui.mode === 'confirm' && card.kind === 'call') return this.confirmPaper(card.call)
        if (this.ui.mode === 'close' && card.kind === 'position') return this.confirmClose(card.pos)
        if (card.kind === 'call') return this.startPaper(card.call)
        break
      case 'skip':
        if (card.kind !== 'call') break
        card.call.dismissed = true
        this.ui.mode = 'browse'
        this.flash(`${heard} → skipped`)
        return this.changed('skip')
      case 'close':
        if (card.kind === 'position') { this.startClose(); this.flash(`${heard} → tap to close`); return this.view() }
        break
      case 'cancel':
        return this.cancel(heard)
      case 'score':
        this.ui.mode = 'browse'
        this.ui.cardId = 'scores'
        return this.changed('nav')
      case 'positions': {
        const p = this.book.open()[0]
        if (p) { this.ui.mode = 'browse'; this.ui.cardId = p.id; return this.changed('nav') }
        break
      }
    }
    this.flash(`${heard} → no action here`)
    return this.changed('voice')
  }

  startPaper(call) {
    const c = this.book.check(call, this.size(), this.mids[call.ticket.coin])
    if (!c.ok) {
      this.ui.mode = 'browse'
      this.flash(`Can't paper this: ${c.reason}`)
      return this.changed('refused')
    }
    this.ui.mode = 'confirm'
    this.ui.preview = c.preview
    return this.changed('confirm')
  }

  async confirmPaper(call) {
    const res = this.book.openFromCall(call, this.size(), this.mids[call.ticket.coin], this.now())
    this.ui.mode = 'browse'
    this.ui.size = null
    if (!res.ok) {
      this.flash(`Can't paper this: ${res.reason}`)
      return this.changed('refused')
    }
    const preview = this.ui.preview ?? { risk: 0 }
    this.ui.preview = null
    this.ui.cardId = res.position.id
    this.flash(`Paper ${res.position.side} ${res.position.coin} opened · logged to Telegram`)
    this.safeJournal(V.journalOpen(res.position, preview))
    return this.changed('opened')
  }

  startClose() {
    this.ui.mode = 'close'
    return this.changed('close?')
  }

  confirmClose(pos) {
    const res = this.book.close(pos.id, this.mids[pos.coin], 'manual', this.now())
    this.ui.mode = 'browse'
    if (!res.ok) {
      this.flash(`Can't close: ${res.reason}`)
      return this.changed('refused')
    }
    const pnl = this.book.pnl(res.position)
    this.flash(`Closed ${pos.coin} ${V.usd(pnl.usd)} · logged to Telegram`)
    this.safeJournal(V.journalClose(res.position, pnl))
    return this.changed('closed')
  }

  cancel(heard) {
    this.ui.mode = 'browse'
    this.ui.preview = null
    this.ui.size = null
    this.flash(heard ? `${heard} → cancelled` : 'Cancelled')
    return this.changed('cancel')
  }

  postScores() {
    this.safeJournal(V.journalScores(this.scores()))
    this.flash('Scores posted to Telegram')
    return this.changed('scores')
  }

  setDefaultSize(n) {
    this.settings.defaultSize = n
    this.changed('settings')
  }

  // ---- plumbing ---------------------------------------------------------------

  flash(text) {
    this.ui.flash = { text, until: this.now() + FLASH_MS }
  }

  safeJournal(text) {
    Promise.resolve(this.journal(text)).catch((err) => this.emit('warn', `journal failed: ${err.message}`))
  }

  changed(reason) {
    this.emit('persist')
    return this.refresh(reason)
  }

  /** Bumps the version only when what the glasses would show actually changed. */
  refresh(reason = 'tick') {
    const v = this.view()
    const key = JSON.stringify(v)
    if (key !== this.lastView) {
      this.lastView = key
      this.version++
      this.emit('view', { version: this.version, reason })
    }
    return { ...v, version: this.version }
  }
}
