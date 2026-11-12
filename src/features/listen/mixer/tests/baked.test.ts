/** Baked clips (baked.ts): their span, key, file format, and finding a lossy part's codec delay. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { alignPart, BAKE_MARGIN_S, bakeKey, clipRange, keyText, wav24 } from '../baked.ts'
import { deckPlan, positionAt } from '../deck-schedule.ts'
import { REVERB_TAIL_S } from '../engine.ts'
import { neutral, transition } from './deck-fixtures.ts'

test('a clip spans from before anything happens to after B settles and the tails die', () => {
  assert.deepEqual(clipRange(transition({ length: 16 })), { start: -BAKE_MARGIN_S, end: 16 + BAKE_MARGIN_S })
  const glide = transition({ length: 16, bAt: 3, rateB: [{ t: 3, v: 1.02 }, { t: 30, v: 1 }] })
  assert.equal(clipRange(glide).end, 30 + BAKE_MARGIN_S)
  const hall = transition({ length: 16, a: { ...neutral(), reverb: [{ t: 12, v: 0 }, { t: 16, v: 1 }] } })
  assert.ok(Math.abs(clipRange(hall).end - (16 + REVERB_TAIL_S + BAKE_MARGIN_S)) < 1e-9)
})

test('the key: the same for the same sound, different for any change', async () => {
  const base = { transition: transition(), a: 'a:1', b: 'b:2' }
  const key = await bakeKey(base)
  assert.match(key, /^[0-9a-f]{32}$/)
  // Key order, sub-0.1 ms noise, the editor's flags and the baked clip itself don't matter...
  const reordered = Object.fromEntries(Object.entries(transition()).reverse()) as ReturnType<typeof transition>
  assert.equal(await bakeKey({ ...base, transition: reordered }), key)
  assert.equal(await bakeKey({ ...base, transition: transition({ aOut: 100.00001, custom: true, confidence: 0.2, baked: { url: 'x', key: 'y', start: -0.5, length: 20 } }) }), key)
  // ...any change of the sound or the songs does.
  assert.notEqual(await bakeKey({ ...base, transition: transition({ length: 16.5 }) }), key)
  assert.notEqual(await bakeKey({ ...base, b: 'b:3' }), key)
  assert.ok(keyText(base).startsWith('{"a":"a:1"'))
})

test('wav24: header and samples', () => {
  const left = Float32Array.of(0, 0.5, -1, 2)
  const right = Float32Array.of(1, -0.5, 0, -2)
  const view = new DataView(wav24([left, right], 48000))
  const text = (at: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(at + i)))
  assert.equal(text(0), 'RIFF')
  assert.equal(text(8), 'WAVE')
  assert.equal(view.getUint16(22, true), 2)
  assert.equal(view.getUint32(24, true), 48000)
  assert.equal(view.getUint16(34, true), 24)
  assert.equal(view.getUint32(40, true), 4 * 2 * 3)
  const sample = (index: number) => {
    const at = 44 + index * 3
    const value = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)
    return value / 8388607
  }
  // Interleaved: left 0, right 0, left 1, ...
  assert.equal(sample(0), 0)
  assert.ok(Math.abs(sample(1) - 1) < 1e-6)
  assert.ok(Math.abs(sample(2) - 0.5) < 1e-6)
  assert.ok(Math.abs(sample(4) + 1) < 1e-6)
  // Beyond full scale: clipped.
  assert.ok(Math.abs(sample(6) - 1) < 1e-6)
  assert.ok(Math.abs(sample(7) + 1) < 1e-6)
})

/** Seeded noise with some tone in it. */
function audio(length: number, seed = 11) {
  let state = seed
  const random = () => ((state = (state * 16807) % 2147483647) / 2147483647) * 2 - 1
  return Float32Array.from({ length }, (_, i) => 0.5 * random() + 0.3 * Math.sin(i * 0.031))
}

test("alignPart finds a lossy part's codec delay against the song's own audio", () => {
  const rate = 8000
  const t = transition({ aOut: 100, bAt: 2, bIn: 30, length: 10, rateB: [{ t: 2, v: 1.02 }, { t: 12, v: 1 }] })
  // A's audio from track position 90; its clip part starts at transition time -0.5 (track position 99.5), half scale,
  // and its decoder added 1234 samples of priming.
  const songA = audio(30 * rate)
  const priming = 1234
  const partA = new Float32Array(priming + 2 * rate)
  for (let i = 0; i < 2 * rate; i++) partA[priming + i] = 0.5 * songA[Math.round((99.5 - 90) * rate) + i]!
  // (Looked for past the priming: the stretch searched must be audio in the decoded part.)
  const head = alignPart({ part: partA, sampleRate: rate, from: 0.2, reference: songA, referenceStart: 90, transition: t, deck: 'a', clipStart: -0.5 })
  assert.ok(head)
  assert.ok(Math.abs(head.delay - priming / rate) < 0.5 / rate, `${head.delay}`)
  assert.ok(head.score > 0.99)
  // B's tail: its clip part ends where B plays plainly (after its glide); a part without delay finds 0.
  const songB = audio(60 * rate, 23)
  const planB = deckPlan(t, 'b')
  const clipStart = -0.5
  const tailTime = 13
  const partB = new Float32Array(Math.round((tailTime + 1 - clipStart) * rate))
  const position = positionAt(planB, tailTime)
  for (let i = 0; i < rate; i++) partB[Math.round((tailTime - clipStart) * rate) + i] = 0.5 * songB[Math.round((position - 20) * rate) + i]!
  const tail = alignPart({ part: partB, sampleRate: rate, from: tailTime - clipStart, reference: songB, referenceStart: 20, transition: t, deck: 'b', clipStart })
  assert.ok(tail)
  assert.ok(Math.abs(tail.delay) < 0.5 / rate, `${tail.delay}`)
  // Unrelated audio: not found.
  assert.equal(alignPart({ part: audio(3 * rate, 99), sampleRate: rate, from: 0.05, reference: songA, referenceStart: 90, transition: t, deck: 'a', clipStart: -0.5 }), null)
})
