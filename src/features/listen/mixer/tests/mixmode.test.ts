/** Mix-Modus: which windows of its songs a playlist asks stems for (mixmode/windows.ts). */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { covered, playlistWindows, tidyWindows, transitionWindows } from '../mixmode/windows.ts'
import type { Transition } from '../types.ts'

const still = () => ({ gain: [], low: [], mid: [], high: [], filter: [] })
const transition = (from: string, to: string): Transition =>
  ({
    v: 2,
    from,
    to,
    style: 'clean',
    preset: 'crossfade',
    aOut: 180,
    bAt: 4,
    bIn: 20,
    length: 16,
    pathA: [],
    pathB: [],
    rateA: [],
    rateB: [],
    tempo: { a: 120, b: 120 },
    a: still(),
    b: still(),
    effects: [],
    custom: true,
    confidence: 1,
  }) as Transition

test('a stored transition asks for what it plays, with a margin', () => {
  const w = transitionWindows(transition('x', 'y'))
  assert.ok(w.a.start <= 170 && w.a.end >= 196)
  assert.ok(w.b.start <= 20 && w.b.end >= 32)
})

test('windows are joined, cut to the server limit and capped in number', () => {
  assert.deepEqual(tidyWindows([{ start: 10, end: 50 }, { start: 40, end: 90 }], 300), [{ start: 10, end: 90 }])
  const long = tidyWindows([{ start: 0, end: 700 }], 900)
  assert.deepEqual(long.map((w) => [w.start, w.end]), [[0, 300], [300, 600], [600, 700]])
  assert.equal(tidyWindows(Array.from({ length: 20 }, (_, i) => ({ start: i * 20, end: i * 20 + 5 })), 1000).length, 8)
  assert.deepEqual(tidyWindows([{ start: 290, end: 330 }], 300), [{ start: 290, end: 300 }])
})

test('a playlist asks each song for its opening and close, or what its stored transitions play', () => {
  const durations = { x: 200, y: 240, z: 220 }
  const wanted = playlistWindows(['x', 'y', 'z'], { 'x>y': transition('x', 'y') }, durations)
  // x only goes out (into y, stored), z only comes in (after y, not stored: its opening).
  assert.equal(wanted.x!.length, 1)
  assert.deepEqual(wanted.z, [{ start: 0, end: 75 }])
  // y comes in (stored: around 20 s) and goes out (not stored: its last 90 s).
  assert.equal(wanted.y!.length, 2)
  assert.ok(covered(wanted.y!, 20, 30))
  assert.ok(covered(wanted.y!, 150, 240))
  assert.equal(covered(wanted.y!, 100, 120), false)
})
