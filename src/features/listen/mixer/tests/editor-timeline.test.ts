/** The transition editor's arithmetic (editor/timeline-math.ts): axis, deck positions, grid, keyframe and timing edits. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addKey,
  deckTrack,
  hasLoop,
  laneKeys,
  laneValue,
  loopReachable,
  marksInTime,
  moveBStart,
  moveKey,
  overlapBars,
  removeKey,
  setLength,
  slipDeck,
  tOf,
  toggleLoop,
  withLaneKeys,
  xOf,
  type Axis,
} from '../editor/timeline-math.ts'
import type { Transition } from '../types.ts'

const still = () => ({ gain: [], low: [], mid: [], high: [], filter: [] })

/** A plain transition: A from 100 s, B in at t = 4 from 10 s, A gone at t = 16, both at rate 1. */
function transition(): Transition {
  return {
    v: 2,
    from: 'a',
    to: 'b',
    style: 'clean',
    preset: 'crossfade',
    aOut: 100,
    bAt: 4,
    bIn: 10,
    length: 16,
    pathA: [],
    pathB: [],
    rateA: [],
    rateB: [],
    tempo: { a: 120, b: 120 },
    a: still(),
    b: still(),
    effects: [],
    custom: false,
    confidence: 1,
  } as Transition
}

const axis: Axis = { from: -8, to: 24, pxPerSecond: 10 }

test('maps time and pixels both ways', () => {
  assert.equal(xOf(axis, -8), 0)
  assert.equal(xOf(axis, 0), 80)
  assert.equal(tOf(axis, 80), 0)
})

test('places each deck in its track, and what it leaves out', () => {
  const t = transition()
  const a = deckTrack(t, 'a', axis)
  const b = deckTrack(t, 'b', axis)
  assert.equal(a[0], 92) // t = −8: eight seconds before aOut
  assert.equal(a[80], 100) // t = 0
  assert.equal(a[xOf(axis, 20)], null) // after A is gone
  assert.equal(b[xOf(axis, 2)], null) // before B comes in
  assert.ok(Math.abs(b[xOf(axis, 6)]! - 12) < 1e-9)
  const ghostA = deckTrack(t, 'a', axis, true)
  const ghostB = deckTrack(t, 'b', axis, true)
  assert.ok(Math.abs(ghostA[xOf(axis, 20)]! - 120) < 1e-9) // A's cut end: what would have played
  assert.ok(Math.abs(ghostB[xOf(axis, 2)]! - 8) < 1e-9) // B's skipped start
  assert.equal(ghostA[xOf(axis, 4)], null)
})

test('finds beats where the deck plays them, also through a loop', () => {
  const t = transition()
  const beats = Array.from({ length: 400 }, (_, i) => i * 0.5)
  const times = marksInTime(axis, deckTrack(t, 'b', axis), beats)
  // B plays 10 s at t = 4: beats every 0.5 s from there.
  assert.ok(times.some((x) => Math.abs(x - 4.5) < 0.01))
  assert.ok(times.every((x) => x >= 4 - 0.11))
  const looped = { ...t, pathB: [{ from: 10, to: 12, repeat: 2 }] }
  const loopTimes = marksInTime(axis, deckTrack(looped, 'b', axis), [11])
  // Beat 11 s comes once per pass of the loop (t ≈ 5 and 7), then not again.
  assert.equal(loopTimes.filter((x) => x < 12).length, 2)
})

test('keyframes: adding pins an empty lane, moving keeps the order, values stay in range', () => {
  const added = addKey([], 'gain', 8, 0.4, { from: 0, to: 16 })
  assert.deepEqual(added.keys.map((k) => k.t), [0, 8, 16])
  assert.equal(added.index, 1)
  const moved = moveKey(added.keys, 'gain', 1, 20, 1.7)
  assert.deepEqual(moved[1], { t: 16, v: 1 })
  assert.equal(removeKey(moved, 0).length, 2)
  const filter = addKey([], 'filter', 3, -2)
  assert.equal(filter.keys[0]!.v, -1)
  const t = withLaneKeys(transition(), 'b', 'rate', [{ t: 2, v: 1.02 }])
  assert.deepEqual(laneKeys(t, 'b', 'rate'), [{ t: 2, v: 1.02 }])
  assert.equal(laneValue(t, 'a', 'gain', 5), 1)
  assert.equal(laneValue(t, 'a', 'reverb', 5), 0)
})

test('timing edits: slip, B entry, length, bars in the overlap', () => {
  const t = transition()
  const slipped = slipDeck({ ...t, pathA: [{ from: 100, to: 104, repeat: 2 }] }, 'a', -2)
  assert.equal(slipped.aOut, 98)
  assert.deepEqual(slipped.pathA, [{ from: 98, to: 102, repeat: 2 }])
  const later = moveBStart(t, 6)
  assert.equal(later.bAt, 6)
  assert.equal(later.bIn, 12) // the same material still plays at the same moment
  assert.equal(moveBStart(t, 40).bAt, 16)
  assert.equal(setLength(t, 2).length, 4) // never before B comes in
  assert.equal(overlapBars(t, [], [4, 6, 8, 10, 12, 14, 16, 18]), 6)
})

test('loops: a stretch is played twice and taken out again', () => {
  const t = transition()
  const loop = { deck: 'b' as const, from: 14, to: 18 }
  const looped = toggleLoop(t, loop)
  assert.deepEqual(looped.pathB, [
    { from: 10, to: 14, repeat: 1 },
    { from: 14, to: 18, repeat: 2 },
  ])
  assert.equal(hasLoop(looped, loop), true)
  assert.deepEqual(toggleLoop(looped, loop).pathB, [])
  assert.equal(loopReachable(t, { deck: 'a', from: 90, to: 94 }), false)
})
