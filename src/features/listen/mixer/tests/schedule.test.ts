/**
 * Where a deck is during a transition (deck-schedule.ts on the planner's timeline), and which way a buffer deck plays
 * it (buffer-deck.ts): positions follow the integral of the rate, the points a player follows never drift, loops jump
 * where they go round, and stretched spans are exactly where the rate isn't 1.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bufferDeckKind, EXACT_RATE_TOLERANCE, stretchedSpans } from '../buffer-deck.ts'
import { advanceAt, bSettled, deckPlan, deckSchedule, jumpsOf, pathLength, positionAt, rateOf, timeOfAdvance, trackSpan, withBrake } from '../deck-schedule.ts'
import type { Keyframe } from '../types.ts'
import { transition } from './deck-fixtures.ts'

/** B starts beatmatched, glides back to 1 well after `length` (the BAAB → Rock That Body case). */
const glideB: Keyframe[] = [
  { t: 3.778, v: 1.0117 },
  { t: 18.948, v: 1.0117 },
  { t: 34.298, v: 1 },
]

/** ∫ rate dt by fine midpoint sums (independent of the trapezoids in timeline.ts). */
function integrate(rate: (t: number) => number, from: number, to: number, steps = 200000) {
  let sum = 0
  const dt = (to - from) / steps
  for (let i = 0; i < steps; i++) sum += rate(from + (i + 0.5) * dt) * dt
  return sum
}

/** The keyframed rate at t, written out independently (linear between, held outside). */
function rateAtT(curve: Keyframe[], t: number) {
  if (t <= curve[0]!.t) return curve[0]!.v
  for (let i = 1; i < curve.length; i++) {
    const p = curve[i - 1]!
    const q = curve[i]!
    if (t <= q.t) return p.v + ((q.v - p.v) * (t - p.t)) / (q.t - p.t)
  }
  return curve[curve.length - 1]!.v
}

test('position follows the integral of the rate (to 0.01 ms) through a glide past `length`', () => {
  const plan = deckPlan(transition({ bAt: 3.778, bIn: 30, rateB: glideB }), 'b')
  for (const t of [3.778, 5, 10, 18.948, 20, 26.6, 34.298, 40]) {
    const expected = 30 + integrate((x) => rateAtT(glideB, x), 3.778, t)
    assert.ok(Math.abs(positionAt(plan, t) - expected) < 1e-5, `t = ${t}: ${positionAt(plan, t)} vs ${expected}`)
  }
  // Before its start a deck counts as playing straight at 1.
  assert.equal(advanceAt(plan, 2.778), -1)
  assert.equal(rateOf(plan, 2), 1)
  assert.ok(Math.abs(rateOf(plan, 10) - 1.0117) < 1e-9)
})

test('the schedule points: exact positions, and following them linearly never drifts', () => {
  const plan = deckPlan(transition({ bAt: 3.778, bIn: 30, rateB: glideB }), 'b')
  const points = deckSchedule(plan, 3.778, 40)
  // Every keyframe is a point.
  for (const keyframe of glideB) assert.ok(points.some((point) => Math.abs(point.t - keyframe.t) < 1e-12))
  let position = points[0]!.position
  for (let i = 0; i + 1 < points.length; i++) {
    assert.ok(Math.abs(points[i]!.position - positionAt(plan, points[i]!.t)) < 1e-9)
    position += points[i]!.rate * (points[i + 1]!.t - points[i]!.t)
    assert.ok(Math.abs(position - points[i + 1]!.position) < 1e-9, `drift at ${points[i + 1]!.t}`)
  }
})

test('loops: the deck jumps back where a loop goes round, keeps its advance, and plays on after its path', () => {
  const lane = { start: 30, path: [{ from: 30, to: 34, repeat: 3 }] }
  const plan = deckPlan(transition({ bAt: 0, bIn: 30, pathB: lane.path }), 'b')
  assert.deepEqual(jumpsOf(lane), [4, 8])
  assert.equal(pathLength(lane), 12)
  assert.ok(Math.abs(positionAt(plan, 3.5) - 33.5) < 1e-12)
  assert.ok(Math.abs(positionAt(plan, 4.5) - 30.5) < 1e-12)
  assert.ok(Math.abs(positionAt(plan, 13) - 35) < 1e-12)
  const points = deckSchedule(plan, 0, 14)
  const jumps = points.filter((point) => point.jump).map((point) => point.t)
  assert.deepEqual(jumps.map((t) => Math.round(t * 1e6) / 1e6), [4, 8])
  // A jump starts as far into the new pass as the advance says (not before it).
  for (const point of points.filter((p) => p.jump)) assert.ok(Math.abs(point.position - 30) < 1e-6)
  // What the deck must have loaded: the loop and what follows.
  const span = trackSpan(plan, 0, 14)
  assert.ok(span.from <= 30 && span.to >= 35.99)
})

test('timeOfAdvance inverts the advance', () => {
  const plan = deckPlan(transition({ bAt: 3.778, rateB: glideB }), 'b')
  for (const advance of [0.5, 5, 15.3, 31]) assert.ok(Math.abs(advanceAt(plan, timeOfAdvance(plan, advance)) - advance) < 1e-9)
  assert.equal(timeOfAdvance(plan, -1), 2.778)
})

test('B settles at the latest of: A gone, its rate back at 1, its path walked', () => {
  assert.equal(bSettled(transition({ length: 16 })), 16)
  assert.equal(bSettled(transition({ length: 16, bAt: 3.778, rateB: glideB })), 34.298)
  // A 3 × 4 s loop from bAt 2 ends at 14 (before length 16), a 5 × 4 s one at 22.
  assert.equal(bSettled(transition({ bAt: 2, pathB: [{ from: 30, to: 34, repeat: 5 }] })), 22)
})

test('stretched spans: exactly where the rate is not 1 (from the deck start), joined across keyframes', () => {
  const plan = deckPlan(transition({ bAt: 3.778, rateB: glideB }), 'b')
  assert.deepEqual(stretchedSpans(plan, 3.778, 50), [[3.778, 34.298]])
  // A glides from 1 after t = 0 and holds its meeting rate to the end.
  const planA = deckPlan(
    transition({
      rateA: [
        { t: 0, v: 1 },
        { t: 3, v: 0.9885 },
        { t: 16, v: 0.9885 },
      ],
    }),
    'a',
  )
  assert.deepEqual(stretchedSpans(planA, -8, 16), [[0, 16]])
  assert.deepEqual(stretchedSpans(deckPlan(transition(), 'b'), 0, 20), [])
})

test('buffer deck kind: exact within the tolerance, otherwise the tempo-change setting', () => {
  const within = deckPlan(transition({ rateB: [{ t: 2, v: 1 + EXACT_RATE_TOLERANCE / 2 }] }), 'b')
  assert.equal(bufferDeckKind(within, 2, 20, 'hybrid'), 'exact')
  const beyond = deckPlan(transition({ bAt: 3.778, rateB: glideB }), 'b')
  assert.equal(bufferDeckKind(beyond, 3.778, 40, 'hybrid'), 'hybrid')
  assert.equal(bufferDeckKind(beyond, 3.778, 40, 'stretch'), 'stretch')
  // Only the window counts: after the glide B plays exactly.
  assert.equal(bufferDeckKind(beyond, 35, 60, 'hybrid'), 'exact')
})

test('brake: multiplies A’s rate down to its floor and detunes with it', () => {
  const braking = transition({ effects: [{ kind: 'brake', deck: 'a', at: 10, length: 2 }] })
  const { plan, semitones } = withBrake(braking, deckPlan(braking, 'a'))
  assert.ok(semitones)
  assert.ok(Math.abs(rateOf(plan, 9) - 1) < 1e-9)
  assert.ok(rateOf(plan, 11.9) < 0.2)
  assert.ok(semitones(11.9) < -24)
  assert.equal(semitones(5), 0)
})
