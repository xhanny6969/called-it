// The CalledIt state machine. Everything the glasses show and every action
// they take goes through here, so it is testable without Telegram, without
// the network and without glasses.

import { EventEmitter } from 'node:events'
import { parseCall } from './parse.js'
import { gradeCall, scoreboard } from './grade.js'
import { candlesSince } from './binance.js'
import { PaperBook } from './paper.js'
import { PaperBroker } from './broker.js'
import { intentOf } from './intent.js'
import * as V from './views.js'

const LIVE_WINDOW_MS = 24 * 3_600_000 // calls older than this leave the deck
const HISTORICAL_AFTER_MS = 15 * 60_000 // a forward older than this is graded, not traded
const FLASH_MS = 4_000
const DAY_MS = 86_400_000

export class Engine extends EventEmitter {
  /**
   * @param {object} deps
   * @param {ReturnType<import('./binance.js').createBinance>} deps.market  market list, prices, candles
   * @param {(book: PaperBook) => object} [deps.broker]  where tapped calls go; paper when omitted
   * @param {(text: string) => Promise<unknown>} [deps.journal]  posts to the user's Telegram
   * @param {() => number} [deps.now]
   * @param {object} [state]  persisted state from a previous run
   */
  constructor({ market, broker, journal = async () => {}, now = Date.now }, state = {}) {
    super()
    this.market = market
    this.journal = journal
    this.now = now
    this.calls = state.calls ?? []
    this.book = new PaperBook(state.book)
    this.broker = broker ? broker(this.book) : new PaperBroker(this.book)
    this.brokerError = null
    this.settings = { defaultSize: 50, dailyLossCap: 25, ...state.settings }
    this.chats = new Map(state.chats ?? []) // chatId -> title, for "watching N chats"
    this.seq = state.seq ?? 1
    this.universe = null
    this.mids = {}
    this.ui = { cardId: null, mode: 'browse', size: null, flash: null, preview: null }
    this.version = 1
    this.lastView = ''
    this.lastRegrade = 0
    this.busy = false
    this.ticking = false
  }

  toJSON() {
    return { calls: this.calls, book: this.book.toJSON(), settings: this.settings, chats: [...this.chats], seq: this.seq }
  }

  async init() {
    this.universe = await this.market.universe()
    this.mids = await this.market.mids()
    try {
      return await this.broker.init()
    } catch (err) {
      // A refused demo key must not take the glasses down: fall back to paper trades.
      this.brokerError = err.message
      this.emit('warn', `Binance demo unavailable (${err.message}); using paper trades`)
      this.broker = new PaperBroker(this.book)
      return this.broker.init()
    }
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
    if (t.invalid) return `⚠️ Read a ${t.side} on ${V.name(t.coin)} but skipped it: ${t.invalid}.`
    if (call.historical) {
      return `📊 ${V.describeTicket(t)}\nFrom ${call.source}, ${V.ago(this.now() - call.postedAt)}: ${V.describeGrade(call.grade)}`
    }
    return `👓 On your glasses: ${V.describeTicket(t)}`
  }

  async regrade(call) {
    try {
      const candles = await candlesSince(this.market, call.ticket.coin, call.postedAt, this.now())
      if (candles) call.grade = gradeCall(call.ticket, call.postedAt, candles, this.now())
    } catch (err) {
      this.emit('warn', `grading ${call.id} failed: ${err.message}`)
    }
  }

  // ---- clock ------------------------------------------------------------------

  /** Called every few seconds: new prices, positions closed by stop or TP1, periodic regrade. */
  async tick() {
    if (this.ticking) return // a slow exchange must not stack ticks on top of each other
    this.ticking = true
    try {
      await this.tickOnce()
    } finally {
      this.ticking = false
    }
  }

  async tickOnce() {
    try {
      this.mids = await this.market.mids()
    } catch (err) {
      this.emit('warn', `prices failed: ${err.message}`)
      return
    }
    let closed = []
    try {
      closed = await this.broker.sync(this.mids, this.now())
    } catch (err) {
      this.emit('warn', `positions failed: ${err.message}`)
    }
    for (const p of closed) this.closedNotice(p)
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

  closedNotice(p) {
    const pnl = this.book.pnl(p)
    this.flash(`${V.closeWhy(p.closeReason)}: ${V.name(p.coin)} ${V.usd(pnl?.usd ?? 0)}`)
    this.safeJournal(V.journalClose(p, pnl))
    this.changed('closed')
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
    const label = this.broker.label
    let v
    if (this.ui.mode === 'confirm' && this.ui.preview && card.kind === 'call') {
      v = V.confirmCard(this.ui.preview, card.call, label)
    } else if (this.ui.mode === 'close' && card.kind === 'position') {
      const mid = this.broker.markOf(card.pos, this.mids, now)
      v = V.closeCard(card.pos, { mid, pnl: this.book.pnl(card.pos, mid) })
    } else if (card.kind === 'call') {
      const score = this.scores().find((s) => s.source === card.call.source)
      v = V.callCard(card.call, { mid: this.mids[card.call.ticket.coin], score, size: this.size(), now, pos, label })
    } else if (card.kind === 'position') {
      const mid = this.broker.markOf(card.pos, this.mids, now)
      v = V.positionCard(card.pos, { mid, pnl: this.book.pnl(card.pos, mid), now, pos })
    } else if (card.kind === 'scores') {
      const graded = this.calls.filter((c) => ['tp', 'sl'].includes(c.grade?.status)).length
      v = V.scoreCard(this.scores(), { pos, graded })
    } else {
      v = V.idleCard({ chats: this.chats.size, last: this.lastLine(), venue: this.venueLine() })
    }
    if (this.ui.flash && this.ui.flash.until > now) v = { ...v, footer: this.ui.flash.text }
    return { ...v, kind: card.kind, cardId: card.id, mode: this.ui.mode }
  }

  lastLine() {
    const last = [...this.calls].reverse().find((c) => c.grade && ['tp', 'sl'].includes(c.grade.status))
    return last ? `${V.name(last.ticket.coin)} ${last.ticket.side} from ${last.source}, ${V.describeGrade(last.grade)}` : null
  }

  venueLine() {
    if (this.broker.label === 'demo') {
      const b = this.broker.balance
      return `Orders: Binance demo${Number.isFinite(b) ? `, ${Math.floor(b).toLocaleString('en-US')} USDT` : ''}`
    }
    return this.brokerError ? 'Orders: paper (Binance demo key refused)' : 'Orders: paper (no Binance demo key)'
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
    if (card.kind === 'call') return mode === 'confirm' ? this.confirmTrade(card.call) : this.startTrade(card.call)
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
        this.startTrade(card.call)
        if (this.ui.mode === 'confirm') this.flash(`${heard} → $${intent.usd}, tap to confirm`)
        return this.view()
      case 'confirm':
        if (this.ui.mode === 'confirm' && card.kind === 'call') return this.confirmTrade(card.call)
        if (this.ui.mode === 'close' && card.kind === 'position') return this.confirmClose(card.pos)
        if (card.kind === 'call') return this.startTrade(card.call)
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

  /** Loss booked in the last 24 hours has reached the cap: no new trades. */
  lossCapHit() {
    const cap = this.settings.dailyLossCap
    return cap > 0 && -this.book.realizedSince(this.now() - DAY_MS) >= cap
  }

  refuse(reason) {
    this.ui.mode = 'browse'
    this.ui.preview = null
    this.flash(`Can't ${this.broker.label} this: ${reason}`)
    return this.changed('refused')
  }

  startTrade(call) {
    if (this.lossCapHit()) return this.refuse(`$${this.settings.dailyLossCap} daily loss cap reached`)
    const c = this.broker.preview(call, this.size(), this.mids[call.ticket.coin])
    if (!c.ok) return this.refuse(c.reason)
    this.ui.mode = 'confirm'
    this.ui.preview = c.preview
    return this.changed('confirm')
  }

  async confirmTrade(call) {
    if (this.busy) return this.view() // a second tap while the order is in flight
    if (this.lossCapHit()) return this.refuse(`$${this.settings.dailyLossCap} daily loss cap reached`)
    this.busy = true
    let res
    try {
      res = await this.broker.open(call, this.size(), this.mids[call.ticket.coin], this.now())
    } catch (err) {
      res = { ok: false, reason: err.message }
    } finally {
      this.busy = false
    }
    this.ui.size = null
    if (!res.ok) {
      if (res.closed) this.safeJournal(V.journalClose(res.closed, this.book.pnl(res.closed)))
      return this.refuse(res.reason)
    }
    this.ui.mode = 'browse'
    this.ui.preview = null
    const p = res.position
    this.ui.cardId = p.id
    this.flash(p.venue === 'binance-demo'
      ? `Demo ${p.side} ${V.name(p.coin)} filled at ${V.px(p.entry)} · logged to Telegram`
      : `Paper ${p.side} ${V.name(p.coin)} opened · logged to Telegram`)
    this.safeJournal(V.journalOpen(p))
    if (res.closed) this.closedNotice(res.closed)
    return this.changed('opened')
  }

  startClose() {
    this.ui.mode = 'close'
    return this.changed('close?')
  }

  async confirmClose(pos) {
    if (this.busy) return this.view()
    this.busy = true
    let res
    try {
      res = await this.broker.close(pos, this.broker.markOf(pos, this.mids, this.now()), this.now())
    } catch (err) {
      res = { ok: false, reason: err.message }
    } finally {
      this.busy = false
    }
    this.ui.mode = 'browse'
    if (!res.ok) {
      this.flash(`Can't close: ${res.reason}`)
      return this.changed('refused')
    }
    const pnl = this.book.pnl(res.position)
    this.flash(`Closed ${V.name(pos.coin)} ${V.usd(pnl.usd)} · logged to Telegram`)
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
