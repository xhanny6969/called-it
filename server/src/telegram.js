// Telegram Bot API: read calls from the channels/groups the bot sits in and
// from messages forwarded to it; write the paper-trade journal back.

export function createTelegram({ token, fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing')
  const base = `https://api.telegram.org/bot${token}`

  async function call(method, params = {}, timeoutMs = 15_000) {
    const res = await fetchImpl(`${base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const json = await res.json().catch(() => ({}))
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? `HTTP ${res.status}`}`)
    return json.result
  }

  return {
    getMe: () => call('getMe'),
    getUpdates: (offset, timeout = 25) =>
      call('getUpdates', { offset, timeout, allowed_updates: ['message', 'channel_post', 'edited_channel_post'] }, (timeout + 10) * 1000),
    sendMessage: (chatId, text, extra = {}) =>
      call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...extra }),
  }
}

function originName(o) {
  if (!o) return null
  if (o.type === 'channel') return o.chat?.title ?? 'a channel'
  if (o.type === 'chat') return o.sender_chat?.title ?? 'a group'
  if (o.type === 'user') return [o.sender_user?.first_name, o.sender_user?.last_name].filter(Boolean).join(' ') || 'someone'
  if (o.type === 'hidden_user') return o.sender_user_name ?? 'someone'
  return null
}

/** Normalises one update into what the engine needs. */
export function messageFromUpdate(u) {
  const m = u.message ?? u.channel_post ?? u.edited_channel_post
  if (!m) return null
  const text = m.text ?? m.caption ?? ''
  if (!text) return null
  const origin = m.forward_origin ?? (m.forward_date ? { type: 'legacy', date: m.forward_date } : null)
  const forwardedFrom = originName(origin) ?? (m.forward_from_chat?.title ?? null)
  const chatType = m.chat?.type
  return {
    text,
    chatId: m.chat?.id,
    chatType,
    msgId: m.message_id,
    fromId: m.from?.id ?? null,
    source: forwardedFrom ?? (chatType === 'private' ? 'You' : m.chat?.title ?? 'Telegram'),
    postedAt: (origin?.date ?? m.date) * 1000,
    forwarded: Boolean(origin),
    command: chatType === 'private' && /^\/\w+/.test(text) ? text.trim().split(/\s+/) : null,
  }
}

/**
 * Long-polls Telegram forever and routes each message.
 * @param {object} o
 * @param {ReturnType<typeof createTelegram>} o.tg
 * @param {{ get offset(): number, set offset(v: number) }} o.cursor
 * @param {(msg: ReturnType<typeof messageFromUpdate>) => Promise<void>} o.onMessage
 */
export async function pollForever({ tg, cursor, onMessage, onError = console.error, signal }) {
  while (!signal?.aborted) {
    try {
      const updates = await tg.getUpdates(cursor.offset)
      for (const u of updates) {
        cursor.offset = u.update_id + 1
        const msg = messageFromUpdate(u)
        if (msg) await onMessage(msg).catch(onError)
      }
    } catch (err) {
      onError(err)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
}
