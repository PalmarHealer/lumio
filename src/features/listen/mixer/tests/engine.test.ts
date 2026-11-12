/**
 * The engine's pure parts: curve values (steps included), the kill high-pass and filter mappings, the routing span,
 * the tails' ends, and what `scheduleAutomation` puts on each param (read back from the engine's own timeline).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  asPlayed,
  brakeRateAt,
  colouredSpan,
  echoTailEnd,
  filterFrequencies,
  killFrequency,
  REVERB_TAIL_S,
  reverbTailEnd,
  resetDeck,
  scheduleAutomation,
  tailsEnd,
  valueAfter,
  valueAt,
  valueOn,
} from '../engine.ts'
import type { Keyframe } from '../types.ts'
import { fakeDeck, neutral, transition } from './deck-fixtures.ts'

const step = (t: number, from: number, to: number): Keyframe[] => [
  { t, v: from },
  { t, v: to },
]

test('valueAt interpolates and holds; valueAfter takes a step at its own time', () => {
  const curve: Keyframe[] = [
    { t: 1, v: 0 },
    { t: 3, v: 1 },
  ]
  assert.equal(valueAt(curve, 0, 9), 0)
  assert.equal(valueAt(curve, 2, 9), 0.5)
  assert.equal(valueAt(curve, 5, 9), 1)
  assert.equal(valueAt([], 2, 9), 9)
  // A step: before it the old value, from it on the new one.
  assert.equal(valueAt(step(0, 1, 0), 0, 1), 1)
  assert.equal(valueAfter(step(0, 1, 0), 0, 1), 0)
  assert.equal(valueAfter(step(0.5, 1, 0), 0.5, 1), 0)
  assert.equal(valueAfter(step(0.5, 1, 0), 0.25, 1), 1)
  assert.equal(valueAfter(curve, 2, 9), 0.5)
})

test('kill high-pass: transparent from 0.1 up, rising to 200 Hz as the low band reaches 0', () => {
  assert.equal(killFrequency(1), 0)
  assert.equal(killFrequency(0.1), 0)
  assert.ok(Math.abs(killFrequency(0) - 200) < 1e-9)
  assert.ok(Math.abs(killFrequency(0.0999) - 20) < 0.1)
  let previous = 0
  for (let low = 0.099; low >= 0; low -= 0.001) {
    const frequency = killFrequency(low)
    assert.ok(frequency >= previous, `falls at ${low}`)
    previous = frequency
  }
})

test('filter knob: open at 0, low-pass closing below, high-pass rising above', () => {
  const open = filterFrequencies(0, 48000)
  assert.deepEqual(open, { lowpass: 24000, highpass: 0 })
  assert.ok(Math.abs(filterFrequencies(-1, 48000).lowpass - 70) < 1e-6)
  assert.ok(Math.abs(filterFrequencies(1, 48000).highpass - 9000) < 1e-6)
  assert.ok(filterFrequencies(-0.5, 48000).lowpass < 24000 && filterFrequencies(-0.5, 48000).lowpass > 70)
})

test('coloured span: from the first EQ or filter move (a step at the start included) until neutral again', () => {
  assert.equal(colouredSpan(neutral()), null)
  assert.deepEqual(colouredSpan({ ...neutral(), low: step(0, 1, 0) }), { first: 0, last: Infinity })
  const back = colouredSpan({
    ...neutral(),
    filter: [
      { t: 2, v: 0 },
      { t: 4, v: -0.5 },
      { t: 6, v: 0 },
    ],
  })
  assert.deepEqual(back, { first: 2, last: 6 })
})

test('scheduleAutomation: a step at t = 0 is taken on every linear lane', () => {
  for (const lane of ['gain', 'low', 'mid', 'high'] as const) {
    const deck = fakeDeck()
    scheduleAutomation(deck, { ...neutral(), [lane]: step(0, 1, 0) }, 0)
    assert.equal(valueOn(deck[lane].gain, 0.001), 0, lane)
    assert.equal(valueOn(deck[lane].gain, 5), 0, lane)
  }
})

test('scheduleAutomation: the filter and the kill take a step at the start, at their end, and on resuming at it', () => {
  const shut = filterFrequencies(-1, 48000).lowpass
  for (const at of [0, 0.5]) {
    const deck = fakeDeck()
    scheduleAutomation(deck, { ...neutral(), filter: step(at, 0, -1), low: step(at, 1, 0) }, 0)
    assert.ok(Math.abs(valueOn(deck.lowpass.frequency, at + 0.01) - shut) < 1e-6, `filter after a step at ${at}`)
    assert.ok(Math.abs(valueOn(deck.kill[0].frequency, at + 0.01) - 200) < 1e-6, `kill after a step at ${at}`)
    assert.equal(valueOn(deck.low.gain, at + 0.01), 0)
    // Coloured path on by then (the dry one off).
    assert.equal(valueOn(deck.paths.coloured.gain, at + 0.01), 1)
    assert.equal(valueOn(deck.paths.dry.gain, at + 0.01), 0)
  }
  // Resumed exactly at the step (a pause during the transition): scheduled from there, the step is already taken.
  const deck = fakeDeck()
  scheduleAutomation(deck, { ...neutral(), filter: step(0.5, 0, -1), low: step(0.5, 1, 0) }, -0.5, { from: 0.5 })
  assert.ok(Math.abs(valueOn(deck.lowpass.frequency, 0.01) - shut) < 1e-6)
  assert.ok(Math.abs(valueOn(deck.kill[0].frequency, 0.01) - 200) < 1e-6)
  assert.equal(valueOn(deck.low.gain, 0.01), 0)
})

test('scheduleAutomation: before a step and with partial EQ the kill stays transparent', () => {
  const deck = fakeDeck()
  scheduleAutomation(
    deck,
    {
      ...neutral(),
      low: [
        { t: 0, v: 1 },
        { t: 2, v: 0.3 },
      ],
    },
    0,
  )
  for (const t of [0, 1, 2, 5]) assert.equal(valueOn(deck.kill[0].frequency, t), 0)
  assert.ok(Math.abs(valueOn(deck.low.gain, 1) - 0.65) < 1e-9)
})

test('tails: reverb rings from where its send closes, echo by its repeats (at most its fade), both combined', () => {
  assert.equal(reverbTailEnd(transition()), null)
  assert.equal(echoTailEnd(transition()), null)
  assert.equal(tailsEnd(transition()), null)
  const reverb = transition({
    a: {
      ...neutral(),
      reverb: [
        { t: 10, v: 0 },
        { t: 16, v: 1 },
      ],
    },
  })
  assert.ok(Math.abs(reverbTailEnd(reverb)! - (16 + REVERB_TAIL_S)) < 1e-9)
  // An echo of one beat at 120 BPM, feedback 0.5: 10 repeats to −60 dB (+1), 5.5 s after A is cut.
  const echo = transition({ tempo: { a: 120, b: 120 }, effects: [{ kind: 'echo', deck: 'a', at: 12, beats: 1, feedback: 0.5 }] })
  assert.ok(Math.abs(echoTailEnd(echo)! - (16 + 5.5)) < 1e-9)
  // Strong feedback: capped at the 6 s the return fades over.
  const long = transition({ effects: [{ kind: 'echo', deck: 'a', at: 12, beats: 2, feedback: 0.9 }] })
  assert.equal(echoTailEnd(long), 16 + 6)
  assert.equal(tailsEnd({ ...reverb, effects: echo.effects, tempo: echo.tempo }), 16 + 5.5)
})

test("asPlayed: 'none' is back to back from A's end, others unchanged", () => {
  const plain = transition()
  assert.equal(asPlayed(plain, 200), plain)
  const none = asPlayed(transition({ preset: 'none', a: { ...neutral(), gain: step(3, 1, 0) } }), 200)
  assert.equal(none.aOut, 200)
  assert.equal(none.length, 0)
  assert.deepEqual(none.a.gain, [])
})

test('brake: the rate falls from 1 to 0 over its length', () => {
  assert.ok(Math.abs(brakeRateAt(0, 2) - 1) < 1e-9)
  assert.ok(brakeRateAt(2, 2) <= 1e-9)
  let previous = 1
  for (let t = 0; t <= 2; t += 0.1) {
    const rate = brakeRateAt(t, 2)
    assert.ok(rate <= previous + 1e-12)
    previous = rate
  }
})

/** Whether a param passes through cutoffs between 0 and 20 Hz anywhere in [from, to] (a high-pass must jump there). */
function nearZero(param: Parameters<typeof valueOn>[0], from: number, to: number) {
  for (let t = from; t <= to; t += 0.0001) {
    const value = valueOn(param, t)
    if (value > 1e-9 && value < 20 - 1e-9) return t
  }
  return null
}

test('high-passes jump into and out of 0 Hz, never ramp through a fraction of a hertz', () => {
  // The filter knob sweeping a high-pass back to open, and the low band falling into a kill and rising out of it.
  const deck = fakeDeck()
  scheduleAutomation(
    deck,
    {
      ...neutral(),
      filter: [
        { t: 0, v: 0.6 },
        { t: 1, v: 0 },
      ],
      low: [
        { t: 0, v: 1 },
        { t: 1, v: 0 },
        { t: 2, v: 0 },
        { t: 3, v: 1 },
      ],
    },
    0,
  )
  assert.equal(nearZero(deck.highpass.frequency, 0, 1.5), null)
  assert.equal(nearZero(deck.kill[0].frequency, 0, 3.5), null)
  assert.equal(valueOn(deck.highpass.frequency, 1.01), 0)
  assert.ok(valueOn(deck.kill[0].frequency, 1.5) > 199)
  assert.equal(valueOn(deck.kill[0].frequency, 3.01), 0)
  // B gliding back to neutral (resetDeck with a ramp) leaves an open high-pass at 0 Hz.
  const open = fakeDeck()
  resetDeck(open, 0, 0.05)
  assert.equal(nearZero(open.highpass.frequency, 0, 0.1), null)
  assert.equal(nearZero(open.kill[0].frequency, 0, 0.1), null)
})
