import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { intentOf, spokenAmount } from '../src/intent.js'

test('amounts: digits and words, longest phrase wins', () => {
  assert.equal(spokenAmount('Paper 50.'), 50)
  assert.equal(spokenAmount('make it a hundred'), 100)
  assert.equal(spokenAmount('two fifty please'), 250)
  assert.equal(spokenAmount('$1,000'), 1000)
  assert.equal(spokenAmount('nothing here'), null)
})

test('intents from what Whisper actually returns', () => {
  assert.deepEqual(intentOf('Paper 50.'), { type: 'size', usd: 50 })
  assert.deepEqual(intentOf('Make it 100.'), { type: 'size', usd: 100 })
  assert.deepEqual(intentOf('Skip this one.'), { type: 'skip' })
  assert.deepEqual(intentOf('Close it.'), { type: 'close' })
  assert.deepEqual(intentOf('Yes, do it'), { type: 'confirm' })
  assert.deepEqual(intentOf('never mind'), { type: 'cancel' })
  assert.deepEqual(intentOf('show the scoreboard'), { type: 'score' })
  assert.deepEqual(intentOf(''), { type: 'unknown' })
  assert.deepEqual(intentOf('the weather is nice'), { type: 'unknown' })
})

// End-to-end through the real model when it has been fetched (npm run fetch-model).
const haveModel = (() => {
  try { return readFileSync(new URL('../models/Xenova/whisper-tiny.en/config.json', import.meta.url)).length > 0 } catch { return false }
})()

test('speech fixtures map to the right action through Whisper', { skip: !haveModel && 'model not fetched' }, async () => {
  const { transcribe } = await import('../src/stt.js')
  const cases = { paper_fifty: { type: 'size', usd: 50 }, skip: { type: 'skip' }, close_it: { type: 'close' }, one_hundred: { type: 'size', usd: 100 } }
  for (const [file, want] of Object.entries(cases)) {
    const text = await transcribe(readFileSync(new URL(`./fixtures/audio/${file}.wav`, import.meta.url)))
    assert.deepEqual(intentOf(text), want, `${file}: heard "${text}"`)
  }
})
